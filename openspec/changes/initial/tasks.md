# Tasks: add-gh-issue-agent

## 0. Spikes (verify assumptions before building)
- [ ] 0.1 Verify the Lambda durable functions TypeScript SDK API (`step`, `wait`, `waitForCallback`, callback timeouts) and CDK support. Confirm whether a callback can be completed from inside its own submitter (design D4). If it cannot, adopt the D4 fallback.
- [ ] 0.2 Verify Lambda MicroVMs:
  - [ ] idle semantics: does an outbound-only workload get suspended?
  - [ ] the terminate and list API names
  - [ ] the proxy auth token flow
  - [ ] CDK/CloudFormation support
- [ ] 0.3 Confirm that the target region supports MicroVMs and durable functions. Record `CLAUDE_MODEL`. (Check Bedrock model support and record `BEDROCK_MODEL_ID` if Bedrock will be selectable.)
- [ ] 0.4 Confirm `author_association` behavior for private org members. Add the permission-API fallback if needed.
- [ ] 0.5 Verify that Claude Code runs headless in a MicroVM with `CLAUDE_CODE_OAUTH_TOKEN`, and confirm Anthropic's subscription terms allow this automated use. Confirm what usage and rate-limit data the SDK result reports.

## 1. Project scaffolding
- [ ] 1.1 Create a TypeScript monorepo (Node 24). Packages:
  - `infra` (CDK)
  - `ingress`
  - `token-vendor`
  - `orchestrator`
  - `segment`
  - `shared` (types, DynamoDB access, GitHub client)
- [ ] 1.2 Define shared types: `SegmentJob`, `SegmentResult`, `IssueMeta`, `InboxMessage`, and config loading with validation.

## 2. Infrastructure (CDK)
- [ ] 2.1 StateStack:
  - [ ] DynamoDB table (PK/SK, TTL attribute)
  - [ ] versioned S3 transcript bucket with SSE-KMS and lifecycle rules
- [ ] 2.2 Secrets: GitHub App private key and webhook secret in Secrets Manager, plus the Claude subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN_SECRET`).
- [ ] 2.3 IngressStack:
  - [ ] ingress Lambda with a Function URL (auth NONE; signature-verified)
  - [ ] token-vending Lambda; only it can read the key secret
- [ ] 2.4 OrchestratorStack: durable function with a published version/alias, and least-privilege roles.
- [ ] 2.5 SandboxStack:
  - [ ] MicroVM image build (Dockerfile + S3 artifact)
  - [ ] segment execution role: read the Claude token secret, S3 transcript, token-vendor invoke, DynamoDB read of MSG items, durable callback send
  - [ ] sweeper Lambda on a schedule
- [ ] 2.6 Alarms for: FAILED status count, sweeper terminations, ingress 5xx, `MODEL_USAGE_LIMIT` / `MODEL_AUTH_FAILED` failures (and Bedrock throttles).
- [ ] 2.7 Create the SSM parameter `/ai-developer-agent/model-provider` (value `claude-code`) and grant the ingress role read access. Keep `bedrock:InvokeModel*` on the segment role so either provider can be selected at runtime.

## 3. github-integration
- [ ] 3.1 Signature verification (constant-time) and delivery de-duplication.
- [ ] 3.2 Bot filter and `author_association` authorization.
- [ ] 3.3 Event routing for issues, issue comments, PR comments, reviews, review comments, PR closed/merged, and issue closed.
- [ ] 3.4 Start on `issues.labeled` with `AGENT_LABEL`, using a conditional create of META.
- [ ] 3.5 Token vendor: App JWT signing, then a repo-scoped installation token with minimum permissions.
- [ ] 3.6 Document GitHub App registration: permissions, events, webhook URL, secret.

## 4. issue-state
- [ ] 4.1 META create, read, and update helpers with conditional expressions.
- [ ] 4.2 Transactional inbox append (increment `inboxSeq` + put MSG).
- [ ] 4.3 Conditional park (`RUNNING → WAITING`, guarded by `inboxSeq = consumedSeq`).
- [ ] 4.4 Conditional wake (`WAITING → RUNNING`, returning the old `callbackId`).
- [ ] 4.5 Resume after expiry (`EXPIRED → STARTING`), and cancellation flagging.
- [ ] 4.6 PR LINK write and lookup.

## 5. orchestration
- [ ] 5.1 Segment loop: claim, launch, wait, terminate, consume, account tokens (raw `tokensUsed` and provider-weighted `budgetUsed`; derive `tokenBudgetRemaining` per provider).
- [ ] 5.2 Result handling for `questions`, `done` (open PR, set phase REVIEW), `revised`, and `budget_exhausted`.
- [ ] 5.2b `MODEL_BLOCKED` pause and resume (comment or switch), replacing FAILED for model-availability errors.
- [ ] 5.3 Human wait with park, `HUMAN_WAIT_TIMEOUT`, and expiry comment.
- [ ] 5.4 Wake debounce.
- [ ] 5.5 Segment retry up to `SEGMENT_MAX_ATTEMPTS`; failure comment and FAILED status.
- [ ] 5.6 Cancellation handling (PR merged or closed, issue closed).
- [ ] 5.7 Idempotent comment posting (hidden marker) and PR creation (by head branch).
- [ ] 5.8 Budget check before each segment.

## 6. work-segment
- [ ] 6.1 Segment server: `POST /segment` returns 202, de-duplicated by `segmentSeq`. Do no snapshot-time initialization.
- [ ] 6.2 MicroVM launcher implementing the `SegmentLauncher` interface (launch, terminate).
- [ ] 6.3 Harness rehydration: token, clone, branch checkout or create, transcript load, inbox append.
- [ ] 6.4 Harness persistence: commit, push (per-command auth header), transcript save, callback success or failure.
- [ ] 6.5 Token refresh for long segments.
- [ ] 6.6 Sweeper: terminate stale or orphaned MicroVMs.

## 7. agent-loop
- [ ] 7.0 Provider resolution at issue start (label `agent-engine:*` > SSM > default `claude-code`), stored on `META.provider`; provider interface; strip `ANTHROPIC_API_KEY` / `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` from the Claude Code env; record `provider` in every result.
- [ ] 7.0a Engine switch: ingress `/engine` command and `agent-engine:` label handling with authorization and validation, `pendingProvider`, apply step in the orchestrator claim, per-provider `transcriptKey`.
- [ ] 7.0b Handover builder (inbox, marker comments, branch log and diff, no old-provider call) for the first segment after a switch.
- [ ] 7.1 Claude Code (Agent SDK) provider: tool allow-list, terminal tools as MCP tools, session persistence, retries, `MODEL_USAGE_LIMIT` handling. Bedrock Converse provider: parallel tool results, retries, and backoff.
- [ ] 7.2 Tools: `list_files`, `read_file`, `write_file`, `edit_file`, `grep`, `run_command`. Include path confinement and output truncation.
- [ ] 7.3 `run_command` sandboxing: scrubbed env, timeout, process-group kill.
- [ ] 7.4 Terminal tools per phase; result mapping.
- [ ] 7.5 System prompt; untrusted-content delimiting for GitHub text; inline review comment context (path/line/hunk).
- [ ] 7.6 Prompt caching (Claude Code built-in; Converse cache points for bedrock).
- [ ] 7.7 Turn and token limits; budget-exhausted summary.
- [ ] 7.8 Transcript compaction.

## 8. Testing
- [ ] 8.1 Unit tests:
  - [ ] signature verification
  - [ ] authorization
  - [ ] routing
  - [ ] inbox sequencing
  - [ ] park/wake conditional logic
  - [ ] tool path confinement
  - [ ] output truncation
  - [ ] budget weighting: claude-code gets 2x raw tokens, and the remaining-budget conversion after a mid-issue switch
  - [ ] engine switch: authorization, latest-wins, no-op for same provider, rejection of unknown provider or bedrock without a model, apply-step replay
  - [ ] provider resolution precedence (label > SSM > default), stickiness after start, and rejection of conflicting engine labels
- [ ] 8.2 Race tests against DynamoDB Local: concurrent comments during park, and concurrent wakes. Assert no lost wakeup and a single callback.
- [ ] 8.3 Orchestrator tests with the durable SDK's local test runner: questions → wait → wake → done → review → merged.
- [ ] 8.4 Replay idempotency test: force a replay after comment posting and PR creation; assert no duplicates.
- [ ] 8.5 End-to-end test on a sandbox GitHub repo:
  - [ ] label an issue, answer questions after a delay, receive the PR
  - [ ] leave review comments, receive the revision
  - [ ] merge, and see the run end as DONE
- [ ] 8.5b Engine switch end to end: hit `MODEL_USAGE_LIMIT` (simulated), observe `MODEL_BLOCKED`, comment `/engine bedrock`, and see the issue continue from a handover; then switch back.
- [ ] 8.6 Cost check: verify that no Lambda duration or MicroVM charges accrue during a multi-hour human wait.
