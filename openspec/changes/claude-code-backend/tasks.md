# Tasks: claude-code-backend

## 1. Configuration and switch
- [x] 1.1 Add `agentBackend` to config (`AGENT_BACKEND`), validated, default `claude-code`.
- [x] 1.2 CDK: `agentBackend` context, passed to the image; new secret `ai-developer-agent/claude-code-oauth-token` (placeholder `UNSET`) readable by the segment role.
- [x] 1.3 Image: install the Claude Code CLI (pinned) and create `/work` for the agent user.

## 2. Claude Code runner
- [x] 2.1 Stdio MCP server exposing `ask_questions` and `finish` (phase-aware), writing the outcome file.
- [x] 2.2 Stream parser for the `stream-json` events (init, assistant, rate limit, result).
- [x] 2.3 Runner: build arguments and environment, spawn as the agent user, process-group timeout, session id handling, one nudge when no terminal tool was called.
- [x] 2.4 Outcome mapping: questions, done, revised, continue, budget exhausted, rate limited, failures.
- [x] 2.5 Mid-run token budget enforcement from stream usage.

## 3. Harness integration
- [x] 3.1 Branch on the backend. Claude Code path: fixed working directory, restore and save the session directory through S3, token from the secret, skip our transcript and compaction.
- [x] 3.2 Fail clearly when the token is not configured. No fallback to Bedrock.
- [x] 3.3 Backend-aware prompts (terminal tool names, subagents, images).

## 4. Orchestrator and reporting
- [x] 4.1 New `rate_limited` outcome: durable wait until reset, bounded, then a note.
- [x] 4.2 Subscription billing label in session costs and the PR cost section.

## 5. Tests
- [x] 5.1 Config and secret handling.
- [x] 5.2 MCP server over real stdio.
- [x] 5.3 Parser against the real captured event shapes.
- [x] 5.4 Runner against a fake `claude`: each outcome, resume arguments, environment, isolation.
- [x] 5.5 Harness: Claude Code path, session save and restore, unconfigured token.
- [x] 5.6 Orchestrator: `rate_limited` wait and retry, cost rendering.

## 6. Docs and rollout
- [x] 6.1 README: choosing the backend, getting and storing the token, switching and redeploying, limits and risks.
- [x] 6.2 Deploy and verify the CLI in a real VM.
- [x] 6.3 Default to `claude-code`; count Claude Code tokens at `1/CLAUDE_CODE_BUDGET_MULTIPLIER` (default 2) against the issue budget.
- [ ] 6.3 With a real token: one supervised issue on `claude-code`, confirm resume, scrub and MCP behavior, record findings in the design.
