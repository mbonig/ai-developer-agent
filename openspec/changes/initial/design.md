# Design: GitHub issue-to-PR agent on AWS

## Context

- An agent works a GitHub issue end to end and converses with humans through comments.
- Human latency ranges from minutes to about 2 days, and waits MUST incur no compute cost.
- Every workload host on AWS that can stay alive while idle caps its lifetime at 8 hours, and its idle state is not free:
  - AgentCore Runtime sessions
  - Lambda MicroVMs, which suspend to a low-cost (not zero-cost) state
- So waiting is handled by a durable orchestrator, and compute runs only as disposable work segments. All agent state lives outside compute.
- Implementation language: TypeScript on Node.js 24 for every component. IaC: AWS CDK (TypeScript).

## Goals / Non-Goals

**Goals**
- Zero compute charge while waiting for humans.
- At most one active execution per issue.
- No lost comments: comments that arrive while a segment runs are queued, never dropped, and never interrupt the segment.
- Segments are disposable: losing one never loses agent progress beyond the current segment.
- The agent never sees GitHub credentials.

**Non-Goals:** see proposal.md.

## Architecture

```
GitHub App webhooks
      │
      ▼
Function URL ─► ingress Lambda ──► DynamoDB (META + inbox)
                    │   │
                    │   └─ start execution (new / resume-after-expiry)
                    └───── SendDurableExecutionCallbackSuccess (wake / cancel)
                                   │
                                   ▼
             Orchestrator (Lambda durable function, numbered alias)
               loop:
                 step: claim inbox range
                 waitForCallback(segment): run-microvm + POST /segment
                 step: terminate MicroVM, mark inbox consumed
                 branch on result: questions | done | revised | error
                 step: post comment / open PR
                 waitForCallback(human): park (conditional) ─► wake on inbox/cancel
                 wait(debounce)
                                   │
                                   ▼
             MicroVM segment (ARM64): segment server
               harness: clone/fetch (token via token-vending Lambda)
               agent loop: Claude Code (Anthropic subscription) + tools
                           [or Bedrock Converse, per SSM / issue label]
               harness: commit/push WIP branch, transcript → S3
               SendDurableExecutionCallbackSuccess/Failure

Scheduled sweeper Lambda ─► terminate orphaned MicroVMs
```

## Decisions

### D1. Wait in Lambda durable functions, not in compute
- `waitForCallback` suspends the execution for up to one year, and on-demand functions incur no duration charge while a wait is in progress.
- Rejected alternatives:
  - **Long-lived suspended MicroVM:** idle cost is non-zero, and the 8-hour total runtime cap is shorter than the human latency.
  - **AgentCore session:** 8-hour cap, and memory is billed while the session is alive.
  - **Step Functions with `.waitForTaskToken`:** viable, but durable functions keep the orchestration in TypeScript.

### D2. Work segments run in Lambda MicroVMs (ARM64)
- **Pros:** VM isolation, launch from a snapshot (fast starts with a pre-baked toolchain), and up to 16 vCPU / 32 GB memory / 32 GB disk.
- **Constraint:** ARM64 only. Accepted, because target builds are arch-agnostic.
- **Fallback:** segment launching sits behind a `SegmentLauncher` interface (`launch(job) → handle`, `terminate(handle)`), so a Fargate launcher can be added later for x86-only repos.

### D3. All agent state is external
| State | Store |
|---|---|
| Code progress | WIP branch `agent/issue-<n>` pushed to GitHub |
| Conversation | Claude Code session file (or Converse `messages[]` for bedrock) in S3 (bucket versioned) |
| Lifecycle, inbox, callback IDs, budget | DynamoDB |

A segment rebuilds everything from these stores. That makes expiry and resume, retries, and crash recovery all the same code path.

### D3a. Claude Code on an Anthropic subscription is the default model backend
- The engine defaults to `claude-code`. Segments run Claude Code (Agent SDK) authenticated with a subscription OAuth token (`claude setup-token`) held in Secrets Manager.
- Bedrock stays available and the segment role keeps its Bedrock permissions. It is chosen deliberately, never as a silent fallback, because a silent switch is how Bedrock usage showed up on a run expected to use the subscription.
- Provider resolution at issue start, highest precedence first: issue label `agent-engine:<provider>`, then the SSM parameter `/ai-developer-agent/model-provider`, then the built-in default `claude-code`. The SSM parameter lets an operator flip the whole deployment without a redeploy. The label lets one issue differ.
- The label is the per-issue mechanism because applying it needs triage permission, like `AGENT_LABEL`. Issue body text is not trusted for this, since its author may be unauthorized.
- The result is stored on `META.provider`. It stays fixed until a maintainer switches it, because the transcript format differs per provider.
- **Mid-issue switch:** an authorized maintainer comments `/engine <provider>` or applies an `agent-engine:<provider>` label. Ingress records `pendingProvider`; the orchestrator applies it when it next claims the inbox, so a running segment is never interrupted.
- **Handover instead of transcript conversion:** the new provider starts a fresh transcript whose first turn is rebuilt from durable sources (issue and inbox messages, the agent's own marker comments, the WIP branch log and diff). No model call to the old provider is needed, which matters because a usage limit or auth failure is the usual reason to switch. The old transcript stays in S3 for audit, and switching back builds a new handover rather than resuming a stale transcript.
- **Model failures are recoverable:** `MODEL_USAGE_LIMIT`, `MODEL_AUTH_FAILED`, and `MODEL_UNAVAILABLE` park the issue in `MODEL_BLOCKED` instead of `FAILED`, with a comment explaining how to retry or switch. Without this, the most useful moment to switch would hit a terminal state.
- **Budget:** one per-issue budget (`MAX_TOKENS_PER_ISSUE`, stated at Bedrock rates) is shared across providers. `claude-code` tokens are weighted at `1 / CLAUDE_CODE_BUDGET_MULTIPLIER` (default 2), so a subscription run gets double the raw tokens. Subscription usage has no per-token price, but a budget still bounds runaway work and shared subscription limits. Weighting, rather than two separate limits, keeps the rule coherent when an issue switches engines mid-run.
- The harness scrubs `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, and `CLAUDE_CODE_USE_VERTEX` from the Claude Code environment, since each overrides subscription auth.
- Each result records `provider`, so usage reports show which backend served a run.
- **Trade-off:** subscription limits are rolling and shared with the token owner's other Claude usage, so a heavy run can hit `MODEL_USAGE_LIMIT`. The segment fails with a clear code and the issue can resume after the reset.
- **Terms check:** confirm that Anthropic's subscription terms permit automated, server-side use of a subscription token for this workload (task 0.5).

### D4. Inbox with conditional park/wake to avoid lost wakeups
- Comments always append to the inbox and increment `inboxSeq`.
- Each segment consumes the range `(consumedSeq, claimedSeq]`.
- **Park:** the orchestrator moves to WAITING only with the condition `inboxSeq = consumedSeq` (nothing unread). This conditional write happens inside the `waitForCallback` submitter, after the callback ID exists.
  - If the condition fails, the submitter completes its own callback immediately, and the loop starts the next segment.
- **Wake:** ingress performs a conditional `WAITING → RUNNING` transition. Only the winner of that transition sends the callback.
- **Fallback** if the SDK does not allow completing a callback from inside its own submitter: re-check the inbox immediately after any human-wait resolves, and park with a time-bounded wait loop instead.

### D5. Wake debounce
After any wake, the orchestrator does `ctx.wait(WAKE_DEBOUNCE_SECONDS)` (default 60, no compute cost) before claiming the inbox. That way a burst of comments, such as a PR review that emits one event per inline comment, lands in a single segment.

### D6. Authorization
- **Starting an issue:** an `issues.labeled` event for `AGENT_LABEL`. Applying a label already requires triage permission or higher.
- **Waking:** comments, reviews, and review comments act only if `author_association ∈ {OWNER, MEMBER, COLLABORATOR}`, and never if the sender is a bot.
- Everything else is ignored and only logged.

### D7. Credentials never enter the agent's reach
- The GitHub App private key is in Secrets Manager and is readable only by the token-vending Lambda.
- Tokens are installation tokens scoped to a single repo with the minimum permissions. Segments fetch them on demand, and they expire within 1 hour.
- The harness, not the agent, performs `git clone`, `fetch`, and `push`. The token is passed per command via `-c http.extraHeader` and is never written to `.git/config` or the environment.
- `run_command` executes with a scrubbed environment.

### D8. Review phase
- After the PR opens, the issue enters phase REVIEW. A `LINK` item maps the PR to the issue.
- PR conversation comments, submitted reviews, and inline review comments go into the same inbox. Inline comments carry path, line, and diff-hunk context.
- In REVIEW, a segment ends with `revised` (pushes commits, posts a summary on the PR) or `questions` (posted on the PR).
- The lifecycle ends when the PR is merged (DONE) or closed without merging (CLOSED), or when the issue is closed.

### D9. Expiry and resume
- A human wait that exceeds `HUMAN_WAIT_TIMEOUT` ends the execution, sets status EXPIRED, and posts a comment.
- A later authorized comment on an EXPIRED or MODEL_BLOCKED issue starts a new execution, which resumes from external state (D3). An engine switch also resumes a MODEL_BLOCKED issue.

### D10. Idempotency
- Every GitHub side effect is check-then-act, because durable replays can re-run unfinished steps:
  - comment posting is keyed by a hidden HTML marker `<!-- agent:<issueKey>:<segmentSeq> -->`
  - PR creation is keyed by the head branch
- Webhook deliveries are de-duplicated by `X-GitHub-Delivery` (TTL item).
- Starting an execution is guarded by a conditional write on META.

## Data Model (single DynamoDB table)

| PK | SK | Attributes |
|---|---|---|
| `ISSUE#<owner>/<repo>#<n>` | `META` | `status`, `phase`, `provider`, `pendingProvider?`, `executionArn`, `callbackId?`, `inboxSeq`, `consumedSeq`, `segmentSeq`, `branch`, `prNumber?`, `transcriptKey` (per provider), `installationId`, `tokensUsed`, `budgetUsed`, `cancelRequested?`, `closeReason?`, `microvmId?`, `segmentCallbackId?`, `updatedAt` |
| `ISSUE#<owner>/<repo>#<n>` | `MSG#<seq, zero-padded>` | `source` (issue_comment, pr_comment, review, review_comment), `author`, `body`, `url`, `path?`, `line?`, `diffHunk?`, `createdAt` |
| `PR#<owner>/<repo>#<prNumber>` | `LINK` | `issueKey` |
| `DELIVERY#<deliveryId>` | `DELIVERY` | `ttl` |

- **Status values:** STARTING, RUNNING, WAITING, EXPIRED, MODEL_BLOCKED, DONE, CLOSED, FAILED, BUDGET_EXHAUSTED.
- **Resumable (non-terminal, no execution):** EXPIRED, MODEL_BLOCKED.
- **Terminal statuses:** DONE, CLOSED, FAILED, BUDGET_EXHAUSTED.
- **Phase values:** IMPLEMENT, REVIEW.

## Segment Contract

**Request:** `POST /segment` returns 202 immediately. Body:

```json
{
  "issueKey": "ISSUE#org/repo#123",
  "owner": "org", "repo": "repo", "issueNumber": 123,
  "installationId": 456,
  "phase": "IMPLEMENT",
  "segmentSeq": 3,
  "callbackId": "...",
  "inbox": { "fromExclusive": 4, "toInclusive": 7 },
  "transcriptKey": "transcripts/org/repo/123/claude-code.json",
  "provider": "claude-code",
  "handover": false,
  "branch": "agent/issue-123",
  "prNumber": null,
  "tokenBudgetRemaining": 3000000   // raw tokens for this segment's provider; 1.5M budget x2 for claude-code
}
```

**Result** (sent as the callback payload):

```json
{ "type": "questions", "markdown": "..." }
{ "type": "done", "pr": { "title": "...", "body": "..." } }
{ "type": "revised", "summaryMarkdown": "..." }
{ "type": "budget_exhausted", "summaryMarkdown": "..." }
{ "tokensUsed": 12345, "headSha": "..." }   // merged into every result
```

Failures are sent via `SendDurableExecutionCallbackFailure`, with an error code and message.

## Configuration

| Name | Default | Notes |
|---|---|---|
| `AGENT_LABEL` | `agent` | Label that starts a run |
| `MODEL_PROVIDER_PARAM` | `/ai-developer-agent/model-provider` | SSM parameter holding `claude-code` or `bedrock`; absent means `claude-code` |
| `ENGINE_LABEL_PREFIX` | `agent-engine:` | Engine label prefix (start override and mid-issue switch), e.g. `agent-engine:bedrock` |
| `ENGINE_COMMAND` | `/engine` | Comment command for a mid-issue switch |
| `CLAUDE_MODEL` | Claude Code default | Model alias passed to Claude Code |
| `CLAUDE_CODE_OAUTH_TOKEN_SECRET` | none (required for claude-code) | Secrets Manager secret holding the subscription token |
| `BEDROCK_MODEL_ID` | none (required only when an issue resolves to bedrock) | Claude model or inference profile ID |
| `MAX_TOKENS_PER_ISSUE` | none (required) | Per-issue budget of input + output tokens, at Bedrock rates |
| `CLAUDE_CODE_BUDGET_MULTIPLIER` | 2 | `claude-code` tokens count `1/N` against the budget, so raw capacity is N times larger |
| `MAX_TURNS_PER_SEGMENT` | 150 | Model turns per segment |
| `TRANSCRIPT_COMPACT_TOKENS` | 120000 | Compaction threshold |
| `HUMAN_WAIT_TIMEOUT` | 7 days | Human wait before EXPIRED |
| `SEGMENT_TIMEOUT` | 2 hours | Segment callback timeout |
| `SEGMENT_MAX_ATTEMPTS` | 2 | Attempts per segment |
| `WAKE_DEBOUNCE_SECONDS` | 60 | Settle window after a wake |
| `RUN_COMMAND_TIMEOUT` | 10 minutes | Per `run_command` call |
| `TOOL_OUTPUT_MAX_BYTES` | 32768 | Head and tail are kept |
| `PR_DRAFT` | false | Open the PR as a draft |
| `SWEEPER_INTERVAL` | 15 minutes | Orphan MicroVM sweep interval |
| `MICROVM_VCPU` / `MICROVM_MEMORY_GB` | 4 / 8 | Per segment |

## Risks / Trade-offs

- **MicroVM idle semantics (high).** If "idle" means no inbound HTTP, a segment that receives one POST and then works autonomously could be suspended mid-run.
  - Mitigation: set `maxIdleDurationSeconds ≥ SEGMENT_TIMEOUT`, `autoResumeEnabled=false`, and rely on explicit termination.
  - Task 0.2 verifies this.
- **Prompt injection.** Authorized authors limit exposure. However, issue bodies, repo files, and command output are still model input, and egress is unrestricted.
  - Mitigations: no credentials in the agent's reach, branch protection on default branches, changes land only through a PR, and GitHub content is delimited as untrusted data in prompts.
- **`author_association` quirk.** Members with private org membership may appear as CONTRIBUTOR or NONE in some payloads.
  - Mitigation, if observed: fall back to `GET /repos/{owner}/{repo}/collaborators/{user}/permission`.
- **Callback-from-submitter assumption (D4).** May not be supported; a fallback is defined in D4.
- **Replay cost.** Durable replays re-invoke the orchestrator. It holds no heavy state, so this is acceptable.
- **Token cost of resumes.** Mitigated by prompt caching (Claude Code's built-in caching, or `cachePoint` markers for bedrock) and by transcript compaction.
- **Subscription limits.** Usage is capped by the subscription's rolling limits rather than a per-token bill. See D3a.

## Open Questions

1. Actual values for `CLAUDE_MODEL` and `MAX_TOKENS_PER_ISSUE` (and `BEDROCK_MODEL_ID` if Bedrock is ever enabled).
2. The deployment region. It must offer MicroVMs and durable functions (and the Bedrock model, if Bedrock will be selectable).
3. Should removing `AGENT_LABEL` cancel an active run? v1 ignores label removal.
4. Is `HUMAN_WAIT_TIMEOUT = 7 days` acceptable?
5. Should a maintainer be able to raise the budget of a BUDGET_EXHAUSTED issue through a comment command? v1: no.
6. Is egress allow-listing needed before production use?
