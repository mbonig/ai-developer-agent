# Delta for issue-state

## MODIFIED Requirements

### Requirement: Status and phase model
`status` SHALL be one of `STARTING`, `RUNNING`, `WAITING`, `EXPIRED`, `DONE`, `CLOSED`, `FAILED`, `BUDGET_EXHAUSTED`. `phase` SHALL be `IMPLEMENT` or `REVIEW`.

`DONE`, `CLOSED`, `FAILED`, and `BUDGET_EXHAUSTED` SHALL be terminal: no execution runs, and comments are not queued. `DONE` means the issue was closed. `CLOSED` is the same, for records written before this change.

A terminal run SHALL restart when its issue is relabeled if its status is `DONE`, `CLOSED` or `FAILED`, or if it is `BUDGET_EXHAUSTED` with token budget left.

#### Scenario: Comment on a terminal issue
- **WHEN** an authorized comment arrives for an issue with status `DONE`
- **THEN** the comment is not added to the inbox
- **AND** no execution is started
- **AND** a comment on the issue says the run has ended and how to restart it

#### Scenario: Relabel after reopening
- **WHEN** the issue of a `DONE` run is relabeled
- **THEN** the run restarts with `status=STARTING`, keeping its inbox, branch and transcript

## ADDED Requirements

### Requirement: Unlink a finished pull request
When the linked pull request is merged or closed, ingress SHALL clear `prNumber`, set `phase=IMPLEMENT`, advance `prSeq`, set `branch` to the next pull request's branch, and delete the `PR#` link. It SHALL do nothing for a pull request that is not the linked one, and a repeated delivery SHALL change nothing. It SHALL NOT change `status`.

#### Scenario: Duplicate delivery
- **WHEN** the same pull request's closed event arrives twice
- **THEN** the second changes nothing
