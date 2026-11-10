# Delta for agent-backend

## ADDED Requirements

### Requirement: Selectable backend
The deployment SHALL select the model backend with the setting `agentBackend`, whose values are `bedrock` and `claude-code`. The default SHALL be `claude-code`. Changing the value SHALL require no redeploy: segments read the `/ai-developer-agent/agent-backend` SSM parameter when they start, and an issue may override it for itself.

#### Scenario: Default
- **WHEN** no value is set
- **THEN** segments use the Claude Code backend
- **AND** no Bedrock call is made

#### Scenario: Switching
- **WHEN** the SSM parameter is changed to `bedrock`
- **THEN** the next segment that starts runs on the Bedrock Converse backend

### Requirement: Subscription token budget
The per-issue token budget (`maxTokensPerIssue`) SHALL be stated at Bedrock rates. Tokens used by the Claude Code backend SHALL count `1 / CLAUDE_CODE_BUDGET_MULTIPLIER` (default 2) against it, so a Claude Code issue has the multiplier times the raw tokens.

#### Scenario: Doubled raw budget
- **WHEN** the budget is 12,000,000 and a Claude Code issue has used 8,000,000 raw tokens
- **THEN** 4,000,000 count against the budget and the issue may continue

#### Scenario: Switching backends mid-issue
- **WHEN** an issue that used 8,000,000 raw tokens on Claude Code switches to Bedrock
- **THEN** its remaining budget is 8,000,000 Bedrock tokens

#### Scenario: Token not configured
- **WHEN** the backend is `claude-code` and the token secret holds its placeholder
- **THEN** the segment fails with a message saying the token is not configured
- **AND** it does not use Bedrock

### Requirement: Claude Code runs inside the existing sandbox
The Claude Code backend SHALL run `claude -p` as the unprivileged agent user in the repository working tree, with the same isolation as the Bedrock backend: no AWS credentials in its environment, the metadata service blocked, and its whole process group killed on timeout.

#### Scenario: Isolation preserved
- **WHEN** a segment runs on Claude Code
- **THEN** the process runs as the agent user
- **AND** its environment contains no `AWS_*` variables and no GitHub token

### Requirement: Outcomes through an MCP server
The harness SHALL give Claude Code an MCP server with the tools `ask_questions` and `finish`. A call SHALL record the outcome in a file the harness reads after the process exits. The first call SHALL win. In the implement phase `finish` SHALL take a pull request title and body, and in the review phase a summary.

#### Scenario: Questions
- **WHEN** Claude Code calls `ask_questions`
- **THEN** the segment reports `questions` with that markdown

#### Scenario: Finish in the implement phase
- **WHEN** Claude Code calls `finish` with a title and body in the implement phase
- **THEN** the segment reports `done` with that title and body

#### Scenario: Ended without a terminal tool
- **WHEN** Claude Code ends without calling either tool
- **THEN** the harness resumes the session once, asking it to call one
- **AND** if it still has not, reports `questions` with its last text

### Requirement: Sessions persist across segments
The harness SHALL keep the working directory path fixed for this backend, save Claude Code's config directory to S3 after each segment, and restore it before the next. The first segment SHALL start a session with a deterministic id and later segments SHALL resume it.

#### Scenario: Resume
- **WHEN** a second segment starts for the same issue
- **THEN** the saved session is restored
- **AND** Claude Code is started with `--resume` for the same session id

### Requirement: Mapping Claude Code signals
The backend SHALL map the turn limit to `continue`, a segment token-budget overrun to `budget_exhausted`, and a usage-limit window to a new `rate_limited` outcome that carries the seconds until the limit resets.

#### Scenario: Turn limit
- **WHEN** Claude Code stops at its maximum turns
- **THEN** the segment reports `continue`

#### Scenario: Usage limit
- **WHEN** a rate-limit event reports a status other than allowed, with a reset time
- **THEN** the segment reports `rate_limited` with the seconds until that time

### Requirement: Waiting out a usage limit
On `rate_limited` the orchestrator SHALL wait until the limit resets using a durable wait, then start the next session. After several consecutive `rate_limited` sessions it SHALL post a note and wait for a human.

#### Scenario: Wait and retry
- **WHEN** a session ends `rate_limited` with 1800 seconds to reset
- **THEN** the orchestrator waits about 1800 seconds without running compute
- **AND** starts the next session

### Requirement: Cost reporting for subscription sessions
Sessions on the Claude Code backend SHALL report token usage and the API-equivalent cost. The pull request cost section SHALL mark them as included in the subscription, and SHALL NOT present the API-equivalent value as money billed per token.

#### Scenario: Cost section
- **WHEN** a session ran on Claude Code
- **THEN** its row shows it as included in the subscription with the API-equivalent value
