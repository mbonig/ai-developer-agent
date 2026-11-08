# Delta for orchestration

## MODIFIED Requirements

### Requirement: Lifecycle termination events
The orchestrator SHALL end the run only when the issue is closed, with `status=DONE`.

Ingress SHALL set `cancelRequested` with the reason on `META`. If the issue is `WAITING`, ingress SHALL complete the callback so the orchestrator can observe the cancellation.

A pull request being merged, or closed without merge, SHALL NOT end the run.

#### Scenario: Issue closed while waiting
- **WHEN** the issue is closed while `status=WAITING`
- **THEN** the orchestrator wakes, sets `status=DONE`, and ends without launching a segment

#### Scenario: Issue closed while a segment runs
- **WHEN** the issue is closed while `status=RUNNING`
- **THEN** the current segment is allowed to finish
- **AND** the orchestrator then sets `status=DONE` instead of acting on the result
- **AND** it terminates the MicroVM

#### Scenario: Pull request merged
- **WHEN** the linked pull request is merged while the run is `WAITING`
- **THEN** the run stays `WAITING`

## ADDED Requirements

### Requirement: Next pull request
When no pull request is linked, a finished segment that reports `done` SHALL open a new pull request from the run's current branch. After a pull request is unlinked, the branch SHALL be `agent/issue-<n>-<k>` for the k-th pull request, and `agent/issue-<n>` for the first.

#### Scenario: Second pull request after a merge
- **WHEN** the first pull request is merged, and a later comment arrives on the issue
- **THEN** the next segment runs in phase `IMPLEMENT` on `agent/issue-<n>-2`
- **AND** a `done` result opens a second pull request from that branch
