# Delta for work-segment

## ADDED Requirements

### Requirement: MicroVM segment image
The system SHALL build a Lambda MicroVM image for ARM64, based on the AWS-provided AL2023 MicroVM base image.

The image SHALL contain:
- git
- Node.js 24
- ripgrep
- common build toolchains
- the segment server

The segment server SHALL perform no job-specific initialization at image build or snapshot time. That means it SHALL NOT, at that stage:
- create AWS clients
- open connections
- generate IDs
- read the clock for later use

#### Scenario: Snapshot restore
- **WHEN** two MicroVMs launch from the same image
- **THEN** each creates its own AWS clients and connections only after receiving a job

### Requirement: Segment launch and job handoff
For each segment, the orchestrator SHALL:
1. Launch a new MicroVM with the segment image, the segment execution role, and an idle policy that has `autoResumeEnabled=false` and `maxIdleDurationSeconds >= SEGMENT_TIMEOUT`.
2. Record `microvmId` and `segmentCallbackId` on `META`.
3. POST the job to `/segment` on the MicroVM endpoint, authenticated with the service-issued proxy auth token.

The segment server SHALL respond 202 and process the job asynchronously.

#### Scenario: Job accepted
- **WHEN** the orchestrator POSTs a valid job
- **THEN** the server responds 202 within 5 seconds and begins processing

#### Scenario: Duplicate job POST
- **WHEN** the same `segmentSeq` job is POSTed twice to the same MicroVM
- **THEN** the second request responds 202
- **AND** it does not start a second agent loop

### Requirement: Segment launcher abstraction
Segment launching SHALL be implemented behind an interface with these operations:
- `launch(job) → handle`
- `terminate(handle)`

The orchestrator SHALL depend only on this interface, so an alternative launcher (for example, Fargate) can be added without changing orchestration logic.

#### Scenario: Alternate launcher
- **WHEN** a second launcher implementation is registered
- **THEN** no orchestrator code other than launcher selection changes

### Requirement: Rehydration
On receiving a job, the segment harness SHALL:
1. Obtain a repo-scoped installation token from the token-vending function.
2. Clone the repository.
3. Check out `branch` if it exists on the remote. Otherwise, create it from the default branch.
4. Load the transcript from `transcriptKey`, if one exists.
5. Read the inbox `MSG` items in the job's range and append them to the transcript as a single user turn.

#### Scenario: First segment
- **WHEN** no remote branch and no transcript exist
- **THEN** the harness creates the branch from the default branch
- **AND** it starts a new transcript seeded with the issue title, issue body, and repository metadata

#### Scenario: Resumed segment
- **WHEN** the branch and the transcript exist
- **THEN** the working tree matches the remote branch head
- **AND** the transcript is restored with the new comments appended

### Requirement: Harness-owned git credentials
All authenticated git operations SHALL be performed by the harness, not by agent tools. Tokens SHALL be passed per command, through `-c http.extraHeader`.

Tokens SHALL NOT be:
- written to `.git/config`
- written to any file in the working tree
- placed in the environment visible to agent tools

The harness SHALL refresh the token before expiry for segments that run longer than 50 minutes.

#### Scenario: Agent inspects git config
- **WHEN** the agent runs `git config --list` or `env` through `run_command`
- **THEN** no GitHub token appears in the output

### Requirement: Persistence and result reporting
When the agent loop ends, the harness SHALL, in order:
1. Commit any working tree changes, with a message referencing the issue.
2. Push `branch`.
3. Write the transcript to S3 at `transcriptKey`.
4. Send `SendDurableExecutionCallbackSuccess` with the result payload, including `tokensUsed` and `headSha`.

If any step fails, the harness SHALL send `SendDurableExecutionCallbackFailure` with an error code.

#### Scenario: Questions result
- **WHEN** the agent calls `ask_questions`
- **THEN** the branch is pushed, the transcript is saved, and the callback carries `type=questions` and the markdown

#### Scenario: Push rejected
- **WHEN** the push is rejected
- **THEN** the harness sends a callback failure with code `PUSH_FAILED`

### Requirement: Segment termination
The orchestrator SHALL terminate each segment's MicroVM after the segment callback resolves or times out. Termination SHALL be idempotent: terminating an already-terminated MicroVM is a success.

#### Scenario: Normal completion
- **WHEN** the segment callback succeeds
- **THEN** the MicroVM is terminated in the next durable step

#### Scenario: Segment timeout
- **WHEN** no callback arrives within `SEGMENT_TIMEOUT`
- **THEN** the MicroVM is terminated before any retry launches

### Requirement: Orphan sweeper
A scheduled function SHALL run every `SWEEPER_INTERVAL`. It SHALL terminate any segment MicroVM that meets either condition:
- it has run longer than `SEGMENT_TIMEOUT` plus 15 minutes
- its ID does not match the `microvmId` of any `RUNNING` issue

#### Scenario: Orchestrator lost track of a VM
- **WHEN** a MicroVM is running and no `META` item references it
- **THEN** the sweeper terminates it within one interval
