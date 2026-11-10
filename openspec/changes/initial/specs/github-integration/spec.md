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
- **WHEN** a label other than `AGENT_LABEL` or an `agent-engine:` label is applied
- **THEN** the event is ignored

### Requirement: Engine switch
An authorized maintainer SHALL be able to switch the model provider of a tracked, non-terminal issue by either:
- a comment on the issue or its linked PR containing a line `/engine claude-code` or `/engine bedrock`
- applying a label `agent-engine:claude-code` or `agent-engine:bedrock` to the issue

Comment commands SHALL be honored only when the author passes the same authorization as any other wake (`author_association` in OWNER, MEMBER, or COLLABORATOR, and not a bot). Label events need no extra check, since applying a label requires triage permission.

Ingress SHALL record the request as `pendingProvider` on `META`. If several requests arrive before the next segment, the latest one wins. A command comment SHALL also be appended to the inbox like any other comment. A label-only switch SHALL NOT wake a `WAITING` issue, but SHALL resume an issue that is `MODEL_BLOCKED`.

Ingress SHALL reject, with a comment and no state change:
- an unknown provider name
- `bedrock` when `BEDROCK_MODEL_ID` is not configured

A request for the provider already in use SHALL be a no-op.

#### Scenario: Maintainer comments a command
- **WHEN** a collaborator comments `/engine bedrock` on a `WAITING` issue running on `claude-code`
- **THEN** `pendingProvider=bedrock` is recorded
- **AND** the comment is appended to the inbox and wakes the issue

#### Scenario: Outside contributor tries to switch
- **WHEN** a user with `author_association` `CONTRIBUTOR` or `NONE` comments `/engine bedrock`
- **THEN** nothing changes

#### Scenario: Label switch on a blocked issue
- **WHEN** the label `agent-engine:bedrock` is applied to a `MODEL_BLOCKED` issue
- **THEN** `pendingProvider=bedrock` is recorded
- **AND** the issue resumes

#### Scenario: Unknown provider
- **WHEN** a maintainer comments `/engine gpt`
- **THEN** the agent replies with the valid values
- **AND** `pendingProvider` is unchanged

#### Scenario: Switch on a terminal issue
- **WHEN** a switch is requested for an issue with status `DONE`
- **THEN** it is ignored

### Requirement: Event routing
The ingress function SHALL route events to the issue state record as follows:
- `issue_comment` on an issue → that issue
- `issue_comment` on a PR → the linked issue
- `pull_request_review.submitted` with a non-empty body → the linked issue
- `pull_request_review_comment.created` → the linked issue
- `pull_request.closed` → the linked issue
- `issues.closed` → that issue
- `issues.labeled` with an `agent-engine:` label on a tracked issue → engine switch

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
