# Proposal: a Claude Code backend, switchable from Amazon Bedrock

## Why

The agent calls Claude through the Bedrock Converse API, and that has not worked well in practice:
- Some models need a Marketplace subscription the account cannot complete (Sonnet 5.5 was blocked).
- Prompt caching, compaction, context growth and per-token cost all had to be built and tuned by hand.
- Long factory runs are expensive, and a fixed per-issue token cap is the only brake.

Claude Code is Anthropic's own agent harness. It already has the tools, context management (auto-compaction), session resume, subagents, skills and MCP support that this project re-implements. A Claude subscription (Pro, Max, Team) covers its usage without per-token billing.

The goal is a **switch**: the same orchestrator, sandbox, GitHub handling and work modes, with the part that does the thinking replaceable. Changing backend is one setting and a redeploy.

## What Changes

- Add a deployment setting `agentBackend` with values `bedrock` (the default, today's behavior) and `claude-code`.
- Add a Claude Code backend. Each work segment runs `claude -p` headless, as the existing unprivileged agent user inside the existing MicroVM sandbox, authenticated with a long-lived subscription token from `claude setup-token`.
- Claude Code's sessions persist across segments through S3 and `--resume`, so a conversation survives the disposable VMs.
- The segment's outcomes (`ask_questions`, `finish`) reach the harness through a small MCP server that the harness provides to Claude Code.
- Map Claude Code's own signals onto the existing outcomes: turn limit becomes `continue`, a usage-limit window becomes a new `rate_limited` outcome that the orchestrator waits out and retries.
- Report usage and cost per session as before, but label subscription sessions as included in the subscription, with the API-equivalent value shown for scale.
- Install the Claude Code CLI in the MicroVM image, and add a secret for the subscription token.
- Document how to switch in the README.

## Capabilities

### New Capabilities
- `agent-backend`: choosing the backend, running the Claude Code backend inside the sandbox, session persistence, outcome mapping, usage-limit handling, cost reporting.

### Modified Capabilities
None. The existing `agent-loop`, `work-segment` and `orchestration` requirements still describe the Bedrock backend and the shared flow.

## Impact

- **Image:** adds the Claude Code CLI (a large native binary, roughly 300 MB) and a `/work` directory.
- **Secrets:** adds `ai-developer-agent/claude-code-oauth-token`, readable by the segment role.
- **Orchestrator:** one new outcome (`rate_limited`) and cost-row wording.
- **Security:** the subscription token is a credential for the user's Claude account. Claude Code is told to keep it out of the commands it runs, but the process that holds it runs as the agent user. See the design.
- **Policy and limits:** subscription usage is limited by 5-hour and weekly windows, and using a subscription token in automated, server-side runs is the user's decision under Anthropic's terms.

## Non-Goals

- Choosing the backend per repository or per issue. It is one setting for the deployment.
- Mixing backends within one issue.
- Replacing the Bedrock backend. It stays the default.
- Using an Anthropic API key. Only the subscription token is supported here.
