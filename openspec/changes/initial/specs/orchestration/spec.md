# Delta for orchestration

## ADDED Requirements

### Requirement: Durable orchestrator per issue
Each tracked issue SHALL be driven by at most one active Lambda durable function execution. The orchestrator SHALL be written in TypeScript and invoked through a published numbered version or alias, never `$LATEST`.

All non-deterministic work SHALL run inside durable steps:
- AWS API calls
- GitHub API calls
- reading the clock
- generating IDs

#### Scenario: Code deployed while executions are suspended
- **WHEN** a new orchestrator version is deployed while executions are waiting
- **THEN** existing executions resume against the version they started on

### Requirement: Segment loop
The orchestrator SHALL repeat the following steps until a terminal condition:
1. Claim the inbox range and increment `segmentSeq`. If `pendingProvider` is set, apply the switch in the same step and flag the job as a handover.
2. Set `status=RUNNING`.
3. Launch a work segment.
4. Wait on a durable callback for the segment result.
5. Terminate the segment's MicroVM.
6. Mark the inbox range consumed.
7. Add the result's `tokensUsed` to `META.tokensUsed`, and add `tokensUsed × weight(provider)` to `META.budgetUsed`.
8. Act on the result type.

#### Scenario: Segment returns questions
- **WHEN** a segment result has `type=questions`
- **THEN** the orchestrator posts the markdown as a comment:
  - on the issue in phase `IMPLEMENT`
  - on the PR in phase `REVIEW`
- **AND** it then enters a human wait

#### Scenario: Segment returns done in IMPLEMENT
- **WHEN** a segment result has `type=done` in phase `IMPLEMENT`
- **THEN** the orchestrator opens a PR from `branch` to the default branch, with the result's title and body
- **AND** the body references the issue (`Closes #<n>`)
- **AND** the orchestrator writes the `LINK` item, sets `phase=REVIEW`, comments a link to the PR on the issue, and enters a human wait

#### Scenario: Segment returns revised in REVIEW
- **WHEN** a segment result has `type=revised`
- **THEN** the orchestrator posts the summary on the PR and enters a human wait

### Requirement: Zero-compute human wait
Human waits SHALL use `waitForCallback`, so that no Lambda duration is billed while waiting. The wait SHALL be parked using the race-free park transition. Its timeout SHALL be `HUMAN_WAIT_TIMEOUT` (default 7 days).

#### Scenario: Human replies after two days
- **WHEN** an authorized comment arrives 48 hours after the agent asked questions
- **THEN** the execution resumes from its checkpoint
- **AND** no compute was billed for the 48 hours

### Requirement: Wake debounce
After a human wait resolves because of a wake, the orchestrator SHALL wait `WAKE_DEBOUNCE_SECONDS` (default 60) using a durable `wait` before claiming the inbox.

#### Scenario: Review with many inline comments
- **WHEN** a reviewer submits a review that produces ten `pull_request_review_comment` events within a few seconds
- **THEN** all ten are consumed by a single segment

### Requirement: Segment retry and failure
A segment that fails or exceeds `SEGMENT_TIMEOUT` SHALL be retried, up to `SEGMENT_MAX_ATTEMPTS` total attempts, with the same inbox range. If all attempts fail, the orchestrator SHALL:
- set `status=FAILED`
- post a comment on the issue that includes the error code and an execution reference
- end the execution

#### Scenario: Transient segment crash
- **WHEN** the first attempt times out and the second succeeds
- **THEN** the run continues normally
- **AND** the comment range is consumed once

#### Scenario: Persistent failure
- **WHEN** both attempts fail
- **THEN** the issue receives a failure comment and `status=FAILED`

### Requirement: Model-blocked pause
A segment that fails with `MODEL_USAGE_LIMIT`, `MODEL_AUTH_FAILED`, or `MODEL_UNAVAILABLE` SHALL NOT be retried against the same provider beyond its in-segment retries, and SHALL NOT set `status=FAILED`. The orchestrator SHALL instead:
- set `status=MODEL_BLOCKED`
- post a comment naming the provider, the error code, and the reset time when known
- state in that comment how to continue: reply to retry on the same provider, or switch with `/engine <provider>` or an `agent-engine:` label
- end the execution

The inbox range SHALL stay unconsumed. A later authorized comment or engine switch SHALL start a new execution through a conditional `MODEL_BLOCKED → STARTING` write, which retries the same range.

#### Scenario: Usage limit then switch
- **WHEN** a segment fails with `MODEL_USAGE_LIMIT` and a maintainer then comments `/engine bedrock`
- **THEN** a new execution starts
- **AND** its first segment runs on Bedrock over the same unconsumed range, with a handover transcript

#### Scenario: Usage limit then retry
- **WHEN** a maintainer comments "continue" after the limit resets
- **THEN** a new execution starts on the same provider and resumes its existing transcript

### Requirement: Expiry and resume
If a human wait times out, the orchestrator SHALL:
- set `status=EXPIRED`
- post a comment stating that the agent stopped waiting and will resume on the next comment
- end the execution

A later authorized comment on an `EXPIRED` or `MODEL_BLOCKED` issue SHALL be appended to the inbox and SHALL start a new execution. The new execution resumes from the existing branch, transcript, and inbox state.

#### Scenario: Comment after expiry
- **WHEN** an authorized comment arrives on an issue with `status=EXPIRED`
- **THEN** a new execution starts, guarded by a conditional `EXPIRED → STARTING` write
- **AND** its first segment sees that comment and the prior transcript

### Requirement: Lifecycle termination events
The orchestrator SHALL end the run when any of these occurs:
- **PR merged:** `status=DONE`
- **PR closed without merge:** `status=CLOSED`
- **Issue closed:** `status=CLOSED`

Ingress SHALL set `cancelRequested` with the reason on `META`. If the issue is `WAITING`, ingress SHALL complete the callback so the orchestrator can observe the cancellation.

#### Scenario: PR merged while waiting
- **WHEN** the agent's PR is merged while the issue is `WAITING`
- **THEN** the orchestrator wakes, sets `status=DONE`, and ends without launching a segment

#### Scenario: Issue closed while a segment runs
- **WHEN** the issue is closed while `status=RUNNING`
- **THEN** the current segment is allowed to finish
- **AND** the orchestrator then sets `status=CLOSED` instead of acting on the result
- **AND** it terminates the MicroVM

### Requirement: Budget enforcement
Before each segment, the orchestrator SHALL check `budgetUsed` against `MAX_TOKENS_PER_ISSUE`.

`weight(provider)` SHALL be `1` for `bedrock` and `1 / CLAUDE_CODE_BUDGET_MULTIPLIER` (default `0.5`) for `claude-code`. `tokensUsed` stays a raw token count for reporting. The job's `tokenBudgetRemaining` SHALL be `(MAX_TOKENS_PER_ISSUE - budgetUsed) / weight(provider)`, using the provider the segment will run on.

If the budget is exhausted, or a segment returns `type=budget_exhausted`, the orchestrator SHALL:
- set `status=BUDGET_EXHAUSTED`
- post a summary of progress, linking the WIP branch
- end the execution

#### Scenario: Budget reached
- **WHEN** `budgetUsed >= MAX_TOKENS_PER_ISSUE` before a segment would launch
- **THEN** no segment launches
- **AND** the issue receives the budget-exhausted comment

#### Scenario: claude-code gets double the raw tokens
- **WHEN** `MAX_TOKENS_PER_ISSUE=1500000` and an issue has used 2000000 raw tokens on `claude-code`
- **THEN** `budgetUsed=1000000` and the issue may still run
- **AND** the same 2000000 raw tokens on `bedrock` would have exhausted the budget

#### Scenario: Switching engines mid-issue
- **WHEN** an issue has used 2000000 raw tokens on `claude-code` and switches to `bedrock`
- **THEN** `budgetUsed=1000000`
- **AND** the next segment's `tokenBudgetRemaining` is 500000

### Requirement: Idempotent GitHub side effects
Every comment the orchestrator posts SHALL include a hidden marker `<!-- agent:<issueKey>:<segmentSeq>:<kind> -->`. Before posting, the orchestrator SHALL check for an existing comment with that marker.

Before opening a PR, the orchestrator SHALL check for an existing open PR whose head is `branch`.

#### Scenario: Step replayed after posting
- **WHEN** a durable replay re-runs the post-questions step after the comment was already posted
- **THEN** no duplicate comment is created

#### Scenario: PR already exists
- **WHEN** the open-PR step runs and an open PR for `branch` exists
- **THEN** that PR is reused
