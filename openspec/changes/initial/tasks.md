# Tasks: add-gh-issue-agent

## 0. Spikes (verify assumptions before building)
- [x] 0.1 Verify the Lambda durable functions TypeScript SDK API (`step`, `wait`, `waitForCallback`, callback timeouts) and CDK support. Confirm whether a callback can be completed from inside its own submitter (design D4). If it cannot, adopt the D4 fallback.
- [x] 0.2 Verify Lambda MicroVMs:
  - [x] idle semantics: does an outbound-only workload get suspended?
  - [x] the terminate and list API names
  - [x] the proxy auth token flow
  - [x] CDK/CloudFormation support
- [x] 0.3 Confirm that the target region supports MicroVMs and durable functions. Record `CLAUDE_MODEL`. (Check Bedrock model support and record `BEDROCK_MODEL_ID` if Bedrock will be selectable.)
- [ ] 0.4 Confirm `author_association` behavior for private org members. Add the permission-API fallback if needed.
- [ ] 0.5 Verify that Claude Code runs headless in a MicroVM with `CLAUDE_CODE_OAUTH_TOKEN`, and confirm Anthropic's subscription terms allow this automated use. Confirm what usage and rate-limit data the SDK result reports.

## 1. Project scaffolding
- [x] 1.1 Create a TypeScript monorepo (Node 24). Packages:
  - `infra` (CDK)
  - `ingress`
  - `token-vendor`
  - `orchestrator`
  - `segment`
  - `shared` (types, DynamoDB access, GitHub client)
- [x] 1.2 Define shared types: `SegmentJob`, `SegmentResult`, `IssueMeta`, `InboxMessage`, and config loading with validation.

## 2. Infrastructure (CDK)
- [x] 2.1 StateStack:
  - [x] DynamoDB table (PK/SK, TTL attribute)
  - [x] versioned S3 transcript bucket with SSE-KMS and lifecycle rules
- [x] 2.2 Secrets: GitHub App private key and webhook secret in Secrets Manager, plus the Claude subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN_SECRET`).
- [x] 2.3 IngressStack:
  - [x] ingress Lambda with a Function URL (auth NONE; signature-verified)
  - [x] token-vending Lambda; only it can read the key secret
- [x] 2.4 OrchestratorStack: durable function with a published version/alias, and least-privilege roles.
- [x] 2.5 SandboxStack:
  - [x] MicroVM image build (Dockerfile + S3 artifact)
  - [x] segment execution role: read the Claude token secret, S3 transcript, token-vendor invoke, DynamoDB read of MSG items, durable callback send
  - [x] sweeper Lambda on a schedule
- [ ] 2.6 Alarms for: FAILED status count, sweeper terminations, ingress 5xx, `MODEL_USAGE_LIMIT` / `MODEL_AUTH_FAILED` failures (and Bedrock throttles).
- [x] 2.7 Create the SSM parameter `/ai-developer-agent/model-provider` (value `claude-code`) and grant the ingress role read access. Keep `bedrock:InvokeModel*` on the segment role so either provider can be selected at runtime.

## 3. github-integration
- [x] 3.1 Signature verification (constant-time) and delivery de-duplication.
- [x] 3.2 Bot filter and `author_association` authorization.
- [x] 3.3 Event routing for issues, issue comments, PR comments, reviews, review comments, PR closed/merged, and issue closed.
- [x] 3.4 Start on `issues.labeled` with `AGENT_LABEL`, using a conditional create of META.
- [x] 3.5 Token vendor: App JWT signing, then a repo-scoped installation token with minimum permissions.
- [x] 3.6 Document GitHub App registration: permissions, events, webhook URL, secret.

## 4. issue-state
- [x] 4.1 META create, read, and update helpers with conditional expressions.
- [x] 4.2 Transactional inbox append (increment `inboxSeq` + put MSG).
- [x] 4.3 Conditional park (`RUNNING → WAITING`, guarded by `inboxSeq = consumedSeq`).
- [x] 4.4 Conditional wake (`WAITING → RUNNING`, returning the old `callbackId`).
- [x] 4.5 Resume after expiry (`EXPIRED → STARTING`), and cancellation flagging.
- [x] 4.6 PR LINK write and lookup.

## 5. orchestration
- [x] 5.1 Segment loop: claim, launch, wait, terminate, consume, account tokens (raw `tokensUsed` and provider-weighted `budgetUsed`; derive `tokenBudgetRemaining` per provider).
- [x] 5.2 Result handling for `questions`, `done` (open PR, set phase REVIEW), `revised`, and `budget_exhausted`.
- [ ] 5.2b `MODEL_BLOCKED` pause and resume (comment or switch), replacing FAILED for model-availability errors.
- [x] 5.3 Human wait with park, `HUMAN_WAIT_TIMEOUT`, and expiry comment.
- [x] 5.4 Wake debounce.
- [x] 5.5 Segment retry up to `SEGMENT_MAX_ATTEMPTS`; failure comment and FAILED status.
- [x] 5.6 Cancellation handling (PR merged or closed, issue closed).
- [x] 5.7 Idempotent comment posting (hidden marker) and PR creation (by head branch).
- [x] 5.8 Budget check before each segment.

## 6. work-segment
- [x] 6.1 Segment server: `POST /segment` returns 202, de-duplicated by `segmentSeq`. Do no snapshot-time initialization.
- [x] 6.2 MicroVM launcher implementing the `SegmentLauncher` interface (launch, terminate).
- [x] 6.3 Harness rehydration: token, clone, branch checkout or create, transcript load, inbox append.
- [x] 6.4 Harness persistence: commit, push (per-command auth header), transcript save, callback success or failure.
- [x] 6.5 Token refresh for long segments.
- [x] 6.6 Sweeper: terminate stale or orphaned MicroVMs.

## 7. agent-loop
- [ ] 7.0 Provider resolution at issue start (label `agent-engine:*` > SSM > default `claude-code`), stored on `META.provider`; provider interface; strip `ANTHROPIC_API_KEY` / `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` from the Claude Code env; record `provider` in every result.
- [ ] 7.0a Engine switch: ingress `/engine` command and `agent-engine:` label handling with authorization and validation, `pendingProvider`, apply step in the orchestrator claim, per-provider `transcriptKey`.
- [ ] 7.0b Handover builder (inbox, marker comments, branch log and diff, no old-provider call) for the first segment after a switch.
- [x] 7.1 Claude Code (Agent SDK) provider: tool allow-list, terminal tools as MCP tools, session persistence, retries, `MODEL_USAGE_LIMIT` handling. Bedrock Converse provider: parallel tool results, retries, and backoff.
- [x] 7.2 Tools: `list_files`, `read_file`, `write_file`, `edit_file`, `grep`, `run_command`. Include path confinement and output truncation.
- [x] 7.3 `run_command` sandboxing: scrubbed env, timeout, process-group kill.
- [x] 7.4 Terminal tools per phase; result mapping.
- [x] 7.5 System prompt; untrusted-content delimiting for GitHub text; inline review comment context (path/line/hunk).
- [x] 7.6 Prompt caching (Claude Code built-in; Converse cache points for bedrock).
- [x] 7.7 Turn and token limits; budget-exhausted summary.
- [x] 7.8 Transcript compaction.

## 8. Testing
- [x] 8.1 Unit tests:
  - [x] signature verification
  - [x] authorization
  - [x] routing
  - [x] inbox sequencing
  - [x] park/wake conditional logic
  - [x] tool path confinement
  - [x] output truncation
  - [ ] budget weighting: claude-code gets 2x raw tokens, and the remaining-budget conversion after a mid-issue switch
  - [ ] engine switch: authorization, latest-wins, no-op for same provider, rejection of unknown provider or bedrock without a model, apply-step replay
  - [ ] provider resolution precedence (label > SSM > default), stickiness after start, and rejection of conflicting engine labels
- [x] 8.2 Race tests against DynamoDB Local: concurrent comments during park, and concurrent wakes. Assert no lost wakeup and a single callback.
- [x] 8.3 Orchestrator tests with the durable SDK's local test runner: questions → wait → wake → done → review → merged.
- [ ] 8.4 Replay idempotency test: force a replay after comment posting and PR creation; assert no duplicates.
- [ ] 8.5 End-to-end test on a sandbox GitHub repo:
  - [ ] label an issue, answer questions after a delay, receive the PR
  - [ ] leave review comments, receive the revision
  - [ ] merge, and see the run end as DONE
- [ ] 8.5b Engine switch end to end: hit `MODEL_USAGE_LIMIT` (simulated), observe `MODEL_BLOCKED`, comment `/engine bedrock`, and see the issue continue from a handover; then switch back.
- [ ] 8.6 Cost check: verify that no Lambda duration or MicroVM charges accrue during a multi-hour human wait.
