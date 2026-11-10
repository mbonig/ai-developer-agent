# Delta for agent-loop

## ADDED Requirements

### Requirement: Model provider selection
The agent SHALL run on one of two providers:

- `claude-code` (default): run the agent with Claude Code (the Claude Agent SDK / `claude` CLI), authenticated with an Anthropic subscription. Usage is billed against that subscription, not AWS.
- `bedrock`: run the tool-use loop against the Amazon Bedrock Converse API, using `BEDROCK_MODEL_ID`.

The provider for an issue SHALL be resolved once, when its execution starts, with this precedence (highest first):
1. A per-issue override (see below).
2. The SSM parameter named by `MODEL_PROVIDER_PARAM` (default `/ai-developer-agent/model-provider`).
3. The built-in default, `claude-code`.

The resolved provider SHALL be stored on `META.provider` and used for every segment of that issue until a maintainer switches it (see "Engine switch and handover"), because transcripts are provider-specific.

The per-issue override SHALL be a label on the issue, `agent-engine:claude-code` or `agent-engine:bedrock`. Applying a label requires triage permission, so the override inherits the same authorization as `AGENT_LABEL`. If several engine labels are present, the start SHALL be rejected with a comment asking for exactly one.

The deployment SHALL NOT fall back from one provider to the other implicitly. An unknown provider value, from SSM or a label, SHALL be ignored with a logged warning (SSM) or rejected with an issue comment (label). The segment execution role SHALL hold permissions for both providers so that either can be selected at runtime.

#### Scenario: Nothing configured
- **WHEN** no engine label is present and the SSM parameter is absent
- **THEN** the provider is `claude-code`
- **AND** no Bedrock API call is made

#### Scenario: SSM override
- **WHEN** the SSM parameter is `bedrock` and the issue has no engine label
- **THEN** the issue runs on Bedrock

#### Scenario: Issue label beats SSM
- **WHEN** the SSM parameter is `bedrock` and the issue carries `agent-engine:claude-code`
- **THEN** the issue runs on `claude-code`

#### Scenario: Provider is sticky
- **WHEN** the SSM parameter changes after an issue has started
- **THEN** the running issue keeps `META.provider`, including after expiry and resume
- **AND** only an explicit engine switch changes it

#### Scenario: Bedrock selected without a model
- **WHEN** the resolved provider is `bedrock` and `BEDROCK_MODEL_ID` is unset
- **THEN** the start fails with an issue comment and no segment launches

### Requirement: Engine switch and handover
A maintainer SHALL be able to change an issue's provider at any point in its life. The change SHALL take effect at the start of the next segment and SHALL NOT interrupt a running segment.

When the first segment under a new provider starts, the harness SHALL build a fresh transcript for that provider whose opening user turn contains:
- the issue title and body, as untrusted-data blocks
- every inbox message so far, in order, with author attribution
- the agent's own prior comments, found by their hidden `<!-- agent:... -->` markers
- the commit log and `git diff` of the WIP branch against the default branch
- a statement that work began under another provider and may be partly done

The handover SHALL be built without calling the previous provider, because that provider may be the reason for the switch. The previous transcript SHALL be left untouched in S3 for audit. The harness SHALL write the new transcript under a provider-specific key and the orchestrator SHALL record that key as `META.transcriptKey`.

Token usage SHALL count against one per-issue budget across all providers, using the weighting in "Turn and token limits".

#### Scenario: Switch after a usage limit
- **WHEN** an issue is blocked with `MODEL_USAGE_LIMIT` on `claude-code` and a maintainer switches to `bedrock`
- **THEN** the next segment runs on Bedrock with a handover transcript
- **AND** no `claude-code` call is made to produce the handover

#### Scenario: Switch during a running segment
- **WHEN** a switch arrives while a segment is running
- **THEN** that segment finishes on its current provider
- **AND** the next segment runs on the new provider

#### Scenario: Switch back
- **WHEN** an issue switches from `bedrock` back to `claude-code`
- **THEN** a new handover transcript is built
- **AND** the earlier `claude-code` transcript is not resumed

### Requirement: Claude Code subscription authentication
When the resolved provider is `claude-code`, the segment SHALL authenticate using a long-lived subscription OAuth token (from `claude setup-token`) stored in Secrets Manager as `CLAUDE_CODE_OAUTH_TOKEN`.

The harness SHALL:
- fetch the token at segment start and pass it only to the Claude Code process
- NOT set `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, or `CLAUDE_CODE_USE_VERTEX` (an API key or cloud-provider flag would override subscription billing)
- NOT expose the token to `run_command` or any agent-visible environment

#### Scenario: Default segment
- **WHEN** a segment runs with the default configuration
- **THEN** Claude Code is launched with `CLAUDE_CODE_OAUTH_TOKEN`
- **AND** the process environment contains no `ANTHROPIC_API_KEY` and no `CLAUDE_CODE_USE_BEDROCK`

#### Scenario: Missing subscription token
- **WHEN** the secret is absent or the token is rejected
- **THEN** the segment ends with callback failure, code `MODEL_AUTH_FAILED`
- **AND** no other provider is tried

### Requirement: Tool-use loop
The agent SHALL run a tool-use loop until a terminal tool is called or a limit is reached.

With `claude-code`, Claude Code SHALL drive the loop. Its built-in file, search, and shell tools SHALL be restricted to the tool set below, and the terminal tools SHALL be provided as in-process MCP tools. Permission prompts SHALL be disabled, and tools outside the allow-list SHALL be denied.

With `bedrock`, on each turn the loop SHALL:
1. Send the transcript.
2. Execute every requested tool.
3. Append the tool results.

#### Scenario: Multi-tool turn
- **WHEN** the model requests three tool calls in one response
- **THEN** all three are executed
- **AND** their results are returned in one user turn, in request order

### Requirement: Tool set
The agent SHALL expose these tools:
- `list_files`
- `read_file` (with an optional line range)
- `write_file`
- `edit_file` (exact string replacement that must match exactly once)
- `grep` (backed by ripgrep)
- `run_command`
- `ask_questions` (terminal)
- `finish` (terminal)

File tools SHALL reject paths that resolve outside the repository working tree.

#### Scenario: Path escape
- **WHEN** the model calls `read_file` with `../../etc/passwd`
- **THEN** the tool returns an error
- **AND** no file outside the working tree is read

#### Scenario: Ambiguous edit
- **WHEN** `edit_file`'s old string matches zero times or more than once
- **THEN** the tool returns an error naming the match count

### Requirement: Command execution limits
`run_command` SHALL run commands with all of the following:
- working directory set to the repository root
- a timeout of `RUN_COMMAND_TIMEOUT`
- an environment containing only an allow-listed set of variables (no AWS credentials, no GitHub tokens)

Output SHALL be truncated to `TOOL_OUTPUT_MAX_BYTES`, keeping the head and the tail. The result SHALL include the exit code.

#### Scenario: Long-running command
- **WHEN** a command exceeds `RUN_COMMAND_TIMEOUT`
- **THEN** its process group is killed
- **AND** the tool returns a timeout error with the partial output

#### Scenario: Credential probe
- **WHEN** the model runs `env`
- **THEN** no `AWS_*` credential or token variables appear in the output

### Requirement: Terminal tools by phase
In phase `IMPLEMENT`:
- `finish` SHALL require a PR `title` and `body`
- it SHALL produce result `type=done`

In phase `REVIEW`:
- `finish` SHALL require a `summary`
- it SHALL produce result `type=revised`

In both phases:
- `ask_questions` SHALL require markdown
- it SHALL produce result `type=questions`

#### Scenario: Needs clarification
- **WHEN** the model calls `ask_questions` with a list of questions
- **THEN** the loop ends
- **AND** the segment returns `type=questions`

#### Scenario: Follow-up after partial answers
- **WHEN** a resumed segment's new comments do not answer every open question
- **THEN** the model may call `ask_questions` again with follow-up questions

### Requirement: System prompt and untrusted content
The system prompt SHALL instruct the agent to:
- implement the issue
- ask questions only when blocked
- run the repository's tests when they can be identified
- never attempt to push, open PRs, or obtain credentials

All GitHub-sourced content SHALL be wrapped in clearly delimited untrusted-data blocks that carry author attribution. This includes:
- the issue body
- comments
- review comments

#### Scenario: Injected instruction in a comment
- **WHEN** a comment contains text instructing the agent to ignore prior instructions
- **THEN** the text is presented to the model inside an untrusted-data block, not as a system or tool instruction

### Requirement: Prompt caching
With `claude-code`, Claude Code's built-in prompt caching SHALL be left enabled.

With `bedrock`, Converse requests SHALL include cache points after the system prompt and after the tool definitions.

#### Scenario: Resumed segment (bedrock)
- **WHEN** a segment resumes with an existing transcript
- **THEN** the request includes the cache points

### Requirement: Turn and token limits
A segment SHALL stop after `MAX_TURNS_PER_SEGMENT` model turns (`maxTurns` for `claude-code`, Converse calls for `bedrock`). It SHALL also stop when cumulative token usage would exceed `tokenBudgetRemaining`.

`MAX_TOKENS_PER_ISSUE` is the budget at Bedrock (per-token billing) rates. Because `claude-code` runs on a subscription, its tokens SHALL be weighted at `1 / CLAUDE_CODE_BUDGET_MULTIPLIER` (default multiplier 2) against that budget, so a `claude-code` issue effectively has double the raw tokens. The orchestrator SHALL convert the remaining weighted budget into raw tokens for the segment's provider when it sets `tokenBudgetRemaining`.

On either limit, the segment SHALL:
- persist the transcript and the branch
- return `type=budget_exhausted` with a progress summary

Every result SHALL report `tokensUsed`, the input plus output tokens consumed during the segment, and `provider`, the provider that served it.

With `claude-code`, `tokensUsed` SHALL be taken from the Claude Code result usage report. Any dollar cost figure that Claude Code reports is an API-price estimate, not a charge, and SHALL NOT be presented as Bedrock or AWS spend.

#### Scenario: Turn cap reached
- **WHEN** the loop reaches `MAX_TURNS_PER_SEGMENT`
- **THEN** the segment returns `type=budget_exhausted` with a summary generated by one final model call

#### Scenario: Doubled budget under claude-code
- **WHEN** `MAX_TOKENS_PER_ISSUE=1500000` and an issue runs on `claude-code` with no prior usage
- **THEN** the first segment's `tokenBudgetRemaining` is 3000000

#### Scenario: Usage reporting under the default provider
- **WHEN** a segment completes with `claude-code`
- **THEN** the result carries `provider=claude-code` and the token counts Claude Code reported
- **AND** no usage is attributed to Bedrock

### Requirement: Transcript persistence and compaction
The transcript SHALL be stored in a versioned S3 bucket, encrypted with SSE-KMS. With `claude-code` it is the Claude Code session file, restored before the segment and resumed by session ID. With `bedrock` it is Converse `messages[]` JSON. A transcript SHALL be resumed only by the provider that wrote it.

When the estimated transcript size exceeds `TRANSCRIPT_COMPACT_TOKENS` at the start of a segment, the agent SHALL replace the history with a single user turn containing:
- a model-generated summary of the work and decisions so far
- the outstanding questions and answers
- the current `git diff` against the default branch

#### Scenario: Large transcript
- **WHEN** a resumed transcript is estimated at 150k tokens and the threshold is 120k
- **THEN** the segment compacts before the first working turn
- **AND** the prior version remains retrievable through S3 versioning

### Requirement: Transient model error handling
Throttling, rate-limit, and 5xx errors SHALL be retried with exponential backoff and jitter, up to 5 attempts. Persistent failure SHALL end the segment with a callback failure, code `MODEL_UNAVAILABLE`.

With `claude-code`, an exhausted subscription usage limit SHALL end the segment with callback failure code `MODEL_USAGE_LIMIT`, including the reset time when Claude Code reports one. It SHALL NOT be retried within the segment.

#### Scenario: Throttled request
- **WHEN** the model API returns a throttling error (Converse `ThrottlingException`, or a Claude Code rate-limit error) twice and then succeeds
- **THEN** the loop continues without failing the segment

#### Scenario: Subscription limit reached
- **WHEN** Claude Code reports the subscription usage limit is exhausted
- **THEN** the segment fails with `MODEL_USAGE_LIMIT`
- **AND** the orchestrator does not fall back to Bedrock
