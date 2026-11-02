# Tasks: add-gh-issue-agent

## 0. Spikes (verify assumptions before building)
- [x] 0.1 Verify the Lambda durable functions TypeScript SDK API (`step`, `wait`, `waitForCallback`, callback timeouts) and CDK support. Confirm whether a callback can be completed from inside its own submitter (design D4). If it cannot, adopt the D4 fallback.
- [x] 0.2 Verify Lambda MicroVMs:
  - [x] idle semantics: does an outbound-only workload get suspended?
  - [x] the terminate and list API names
  - [x] the proxy auth token flow
  - [x] CDK/CloudFormation support
- [x] 0.3 Confirm that the target region supports MicroVMs, durable functions, and the chosen Bedrock model. Record `BEDROCK_MODEL_ID`.
- [ ] 0.4 Confirm `author_association` behavior for private org members. Add the permission-API fallback if needed.

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
- [x] 2.2 Secrets: GitHub App private key and webhook secret in Secrets Manager.
- [x] 2.3 IngressStack:
  - [x] ingress Lambda with a Function URL (auth NONE; signature-verified)
  - [x] token-vending Lambda; only it can read the key secret
- [x] 2.4 OrchestratorStack: durable function with a published version/alias, and least-privilege roles.
- [x] 2.5 SandboxStack:
  - [x] MicroVM image build (Dockerfile + S3 artifact)
  - [x] segment execution role: Bedrock invoke, S3 transcript, token-vendor invoke, DynamoDB read of MSG items, durable callback send
  - [x] sweeper Lambda on a schedule
- [x] 2.6 Alarms for: FAILED status count, sweeper terminations, ingress 5xx, Bedrock throttles.

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
- [x] 5.1 Segment loop: claim, launch, wait, terminate, consume, account tokens.
- [x] 5.2 Result handling for `questions`, `done` (open PR, set phase REVIEW), `revised`, and `budget_exhausted`.
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
- [x] 7.1 Converse loop with parallel tool results, retries, and backoff.
- [x] 7.2 Tools: `list_files`, `read_file`, `write_file`, `edit_file`, `grep`, `run_command`. Include path confinement and output truncation.
- [x] 7.3 `run_command` sandboxing: scrubbed env, timeout, process-group kill.
- [x] 7.4 Terminal tools per phase; result mapping.
- [x] 7.5 System prompt; untrusted-content delimiting for GitHub text; inline review comment context (path/line/hunk).
- [x] 7.6 Prompt cache points.
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
- [x] 8.2 Race tests against DynamoDB Local: concurrent comments during park, and concurrent wakes. Assert no lost wakeup and a single callback.
- [x] 8.3 Orchestrator tests with the durable SDK's local test runner: questions → wait → wake → done → review → merged.
- [ ] 8.4 Replay idempotency test: force a replay after comment posting and PR creation; assert no duplicates.
- [ ] 8.5 End-to-end test on a sandbox GitHub repo:
  - [ ] label an issue, answer questions after a delay, receive the PR
  - [ ] leave review comments, receive the revision
  - [ ] merge, and see the run end as DONE
- [ ] 8.6 Cost check: verify that no Lambda duration or MicroVM charges accrue during a multi-hour human wait.
