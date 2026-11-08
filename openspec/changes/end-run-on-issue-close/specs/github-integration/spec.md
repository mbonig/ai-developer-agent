# Delta for github-integration

## MODIFIED Requirements

### Requirement: Event routing
- `pull_request.closed` → unlink that pull request from its issue; the run is not cancelled
- `issues.closed` → cancel that issue's run

(Comment, review and review-comment routing is unchanged.)

## ADDED Requirements

### Requirement: Explain dropped events
When a comment, or a relabel, reaches a run that has ended and is not restarted, ingress SHALL post a short comment on the issue (or pull request) saying so, and what to do. A failure to post SHALL NOT fail the webhook. A relabel of an active run needs no comment.

#### Scenario: Comment after the issue closed
- **WHEN** an authorized comment arrives on a `DONE` run
- **THEN** ingress comments that the run ended when the issue closed, and that reopening and relabeling restarts it
