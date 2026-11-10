# Delta for issue-state

## ADDED Requirements

### Requirement: Per-issue state record
The system SHALL keep exactly one `META` item per tracked issue in a single DynamoDB table, keyed `PK=ISSUE#<owner>/<repo>#<number>`, `SK=META`.

The item SHALL hold:
- `status`, `phase`
- `executionArn`, `callbackId`
- `inboxSeq`, `consumedSeq`, `segmentSeq`
- `branch`, `prNumber`, `transcriptKey`
- `installationId`, `tokensUsed` (raw tokens), `budgetUsed` (provider-weighted tokens)
- `provider` (`claude-code` or `bedrock`), set at start and changed only by an engine switch
- `pendingProvider`, a requested switch not yet applied
- `microvmId`, `segmentCallbackId`
- `updatedAt`

#### Scenario: Record created on start
- **WHEN** a run starts for `org/repo#123`
- **THEN** a `META` item exists with:
  - `status=STARTING`, `phase=IMPLEMENT`
  - `inboxSeq=0`, `consumedSeq=0`, `segmentSeq=0`, `tokensUsed=0`, `budgetUsed=0`
  - `branch=agent/issue-123`
  - `transcriptKey=transcripts/org/repo/123/<provider>.json`

#### Scenario: Concurrent start attempts
- **WHEN** two start attempts for the same issue race
- **THEN** only one conditional write succeeds
- **AND** exactly one orchestrator execution is started

### Requirement: Status and phase model
`status` SHALL be one of:
- `STARTING`
- `RUNNING`
- `WAITING`
- `EXPIRED`
- `MODEL_BLOCKED`
- `DONE`
- `CLOSED`
- `FAILED`
- `BUDGET_EXHAUSTED`

`phase` SHALL be `IMPLEMENT` or `REVIEW`.

`DONE`, `CLOSED`, `FAILED`, and `BUDGET_EXHAUSTED` SHALL be terminal: no execution runs, and comments are not queued.

`EXPIRED` and `MODEL_BLOCKED` SHALL be non-terminal and resumable: no execution runs, but comments are queued and an authorized comment or an engine switch starts a new execution.

#### Scenario: Comment on a terminal issue
- **WHEN** an authorized comment arrives for an issue with status `DONE`
- **THEN** the comment is not added to the inbox
- **AND** no execution is started

### Requirement: Comment inbox
Every accepted comment, review, or review comment SHALL be appended as an `MSG#<seq>` item. In the same DynamoDB transaction, `inboxSeq` SHALL be atomically incremented, and `seq` SHALL equal the new `inboxSeq`.

Each `MSG` item SHALL record:
- `source` (`issue_comment`, `pr_comment`, `review`, or `review_comment`)
- `author`, `body`, `url`, `createdAt`
- `path`, `line`, and `diffHunk`, when present

#### Scenario: Comment while a segment is running
- **WHEN** an authorized comment arrives while `status=RUNNING`
- **THEN** the comment is appended to the inbox
- **AND** no callback is sent
- **AND** the running segment is not interrupted

#### Scenario: Burst of comments
- **WHEN** five authorized comments arrive within one second
- **THEN** five `MSG` items exist with contiguous sequence numbers
- **AND** none are lost

### Requirement: Inbox consumption ranges
A segment SHALL consume exactly the inbox range `(consumedSeq, claimedSeq]`, where `claimedSeq` is the value of `inboxSeq` read when the orchestrator claims the range. After the segment completes successfully, `consumedSeq` SHALL be set to `claimedSeq`.

#### Scenario: Comments arrive mid-segment
- **WHEN** a segment claimed range (4, 7] and comment 8 arrives while it runs
- **THEN** after the segment completes, `consumedSeq=7`
- **AND** comment 8 remains unconsumed for the next segment

#### Scenario: Segment fails
- **WHEN** a segment fails before completing
- **THEN** `consumedSeq` is unchanged
- **AND** the retry consumes the same range

### Requirement: Race-free park
The orchestrator SHALL transition `RUNNING → WAITING` and store `callbackId` only through a conditional write that requires `inboxSeq = consumedSeq`. If the condition fails, the orchestrator SHALL NOT wait and SHALL proceed to the next segment.

#### Scenario: Nothing unread
- **WHEN** the orchestrator parks and `inboxSeq = consumedSeq`
- **THEN** `status=WAITING` and `callbackId` is stored

#### Scenario: Unread comments exist at park time
- **WHEN** the orchestrator parks and `inboxSeq > consumedSeq`
- **THEN** the conditional write fails
- **AND** the human wait resolves immediately
- **AND** the next segment is started

### Requirement: Race-free wake
After appending a message, ingress SHALL attempt a conditional transition `WAITING → RUNNING` that removes `callbackId` and returns its prior value. Only the caller whose transition succeeds SHALL send the durable callback.

#### Scenario: Two comments race to wake
- **WHEN** two comments are appended concurrently while `status=WAITING`
- **THEN** exactly one ingress invocation sends `SendDurableExecutionCallbackSuccess`
- **AND** both comments are in the inbox

### Requirement: Pending provider switch
Ingress SHALL set `pendingProvider` with a plain update. The orchestrator SHALL apply it in a durable step when it claims the inbox for a segment, by writing `provider=pendingProvider`, removing `pendingProvider`, and updating `transcriptKey`, conditional on `pendingProvider` still holding the observed value.

#### Scenario: Switch requested twice before the next segment
- **WHEN** `/engine bedrock` and then `/engine claude-code` arrive while a segment runs
- **THEN** the next segment starts with `provider=claude-code`

#### Scenario: Step replayed
- **WHEN** a durable replay re-runs the apply step after it succeeded
- **THEN** the conditional write fails harmlessly
- **AND** `provider` is unchanged

### Requirement: PR link
When the agent opens a PR, the system SHALL write a `LINK` item `PK=PR#<owner>/<repo>#<prNumber>` that references the issue key, and SHALL set `prNumber` on `META`.

#### Scenario: Lookup from PR event
- **WHEN** a review comment event arrives for `org/repo` PR 456
- **THEN** ingress resolves the issue key through `PR#org/repo#456`

### Requirement: Delivery records
Processed webhook delivery IDs SHALL be stored as `DELIVERY#<id>` items, with a DynamoDB TTL at least 24 hours in the future.

#### Scenario: TTL expiry
- **WHEN** a delivery record is older than its TTL
- **THEN** DynamoDB may delete it without affecting issue state
