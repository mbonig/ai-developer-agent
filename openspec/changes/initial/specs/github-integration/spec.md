# Delta for github-integration

## ADDED Requirements

### Requirement: GitHub App registration
The system SHALL be operated through a single GitHub App that is installable on multiple repositories in an organization.

The App SHALL request these permissions:
- Contents: read/write
- Issues: read/write
- Pull requests: read/write
- Metadata: read

The App SHALL subscribe to these events:
- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review`
- `pull_request_review_comment`

#### Scenario: App installed on a new repo
- **WHEN** the App is installed on an additional repository
- **THEN** webhooks for that repository are delivered to the same ingress endpoint
- **AND** no per-repository infrastructure change is required

### Requirement: Webhook signature verification
The ingress function SHALL verify the `X-Hub-Signature-256` header against the App's webhook secret using a constant-time comparison. It SHALL reject any request that fails verification with HTTP 401 and no side effects.

#### Scenario: Invalid signature
- **WHEN** a request arrives with a missing or invalid signature
- **THEN** ingress responds 401
- **AND** no DynamoDB write, execution start, or callback occurs

#### Scenario: Valid signature
- **WHEN** a request arrives with a valid signature
- **THEN** ingress processes the event and responds 2xx within 10 seconds

### Requirement: Delivery de-duplication
The ingress function SHALL de-duplicate deliveries by `X-GitHub-Delivery`. It SHALL record each processed delivery ID with a TTL of at least 24 hours, using a conditional write.

#### Scenario: Redelivered webhook
- **WHEN** a delivery ID that has already been processed is received again
- **THEN** ingress responds 2xx without reprocessing the event

### Requirement: Bot and self filtering
The ingress function SHALL ignore any event whose `sender.type` is `Bot`, including the App's own bot user.

#### Scenario: Agent posts its own questions
- **WHEN** the App's bot posts a comment on an issue
- **THEN** the resulting `issue_comment` event is ignored
- **AND** the issue inbox is unchanged

### Requirement: Author authorization
The ingress function SHALL act on comments, reviews, and review comments only when the author's `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`. Content from any other author SHALL be ignored and logged with the delivery ID and author login.

#### Scenario: Collaborator comments
- **WHEN** a user with `author_association` `COLLABORATOR` comments on a tracked issue
- **THEN** the comment is appended to that issue's inbox

#### Scenario: Outside contributor comments
- **WHEN** a user with `author_association` `CONTRIBUTOR` or `NONE` comments on a tracked issue
- **THEN** the comment is not added to the inbox and does not wake the agent

### Requirement: Start trigger
The ingress function SHALL start an agent run when an `issues.labeled` event adds the configured `AGENT_LABEL` to an issue that has no active run.

#### Scenario: Label applied
- **WHEN** a user applies the label `agent` to an issue with no existing state record
- **THEN** a state record is created with status `STARTING` and phase `IMPLEMENT`
- **AND** an orchestrator execution is started for that issue

#### Scenario: Label applied to an issue with an active run
- **WHEN** `AGENT_LABEL` is applied to an issue whose status is non-terminal
- **THEN** no new execution is started

#### Scenario: Other label applied
- **WHEN** a label other than `AGENT_LABEL` is applied
- **THEN** the event is ignored

### Requirement: Event routing
The ingress function SHALL route events to the issue state record as follows:
- `issue_comment` on an issue → that issue
- `issue_comment` on a PR → the linked issue
- `pull_request_review.submitted` with a non-empty body → the linked issue
- `pull_request_review_comment.created` → the linked issue
- `pull_request.closed` → the linked issue
- `issues.closed` → that issue

Events for issues or PRs with no state record SHALL be ignored.

#### Scenario: Inline review comment on agent PR
- **WHEN** an authorized reviewer leaves an inline comment on a PR that has a `LINK` item
- **THEN** the comment, with its `path`, `line`, and `diff_hunk`, is appended to the linked issue's inbox

#### Scenario: Comment on an untracked PR
- **WHEN** a comment is made on a PR with no `LINK` item
- **THEN** the event is ignored

### Requirement: Installation token vending
A token-vending function SHALL be the only component with read access to the App private key.

It SHALL return an installation access token that is:
- scoped to exactly one requested repository
- limited to the permissions `contents:write`, `issues:write`, and `pull_requests:write`

Only the orchestrator and segment execution roles SHALL be permitted to invoke it.

#### Scenario: Segment requests a token
- **WHEN** a segment requests a token for `org/repo` with its installation ID
- **THEN** it receives a token valid only for `org/repo`, which expires within 1 hour

#### Scenario: Unauthorized caller
- **WHEN** any other principal invokes the token-vending function
- **THEN** IAM denies the invocation
