# Design: Claude Code backend

## Context

Today a segment is: harness (root) clones, rehydrates, runs our own Converse tool loop, then commits, publishes and reports. The loop talks to Bedrock. Everything else (orchestration, inbox, GitHub, sandbox isolation, work modes, cost section) is independent of which model API is used. This design replaces only the loop.

## Decisions

### D1. One switch, in the deployment
`agentBackend` is a CDK context value (`bedrock` or `claude-code`), passed to the image as `AGENT_BACKEND`. Switching means changing the value and redeploying the sandbox stack. The default is `claude-code`; the SSM parameter (created with that value, never reset by deploys) overrides it per deployment, so existing deployments keep their current value.

The per-issue token budget is stated at Bedrock rates. Claude Code tokens count `1 / CLAUDE_CODE_BUDGET_MULTIPLIER` (default 2) against it, because subscription usage has no per-token price. The harness hands Claude Code the remaining budget times the multiplier and reports the tokens used divided by the multiplier, so the orchestrator keeps one budget in Bedrock-equivalent units.

If `claude-code` is selected but the token secret still holds its placeholder, the segment **fails with a clear message**. It never falls back to Bedrock silently, because that would spend money the user chose not to spend.

### D2. Claude Code runs where the Converse loop ran
The harness keeps its job (clone, rehydrate, commit as the agent user, publish through a bundle, save state, report). Only the middle step changes: instead of `runAgent`, it runs `claude -p` as the unprivileged agent user in the same working tree, with the same isolation (metadata service blocked for that user, no AWS credentials in its environment, process group killed on timeout).

Flags: `--output-format stream-json --verbose` (events), `--permission-mode bypassPermissions` (the MicroVM is the sandbox, and it runs as a non-root user), `--mcp-config` with `--strict-mcp-config` (only our MCP server), `--append-system-prompt` (our work-mode prompt), and a session selector.

### D3. Outcomes come back through an MCP server
Claude Code has no notion of "ask the humans" or "open the pull request". The harness provides a stdio MCP server, `harness`, with two tools:
- `ask_questions(markdown)`
- `finish(title, body)` in the implement phase, or `finish(summary)` in review.

A call writes `{tool, input}` to a file named by `HARNESS_OUTCOME_FILE` and replies that it was recorded. After the process exits, the harness reads the file and maps it to `questions`, `done` or `revised`, exactly as the Converse loop does. The first call wins.

### D4. Sessions survive disposable VMs
Claude Code stores a session under its config directory, keyed by the working directory. So:
- the working directory is a fixed path (`/work/repo`) for this backend;
- `CLAUDE_CONFIG_DIR` points at a directory the harness owns;
- after each segment the config directory is saved to S3 (`claude-session/<owner>/<repo>/<issue>.tgz`) and restored before the next;
- the first segment uses `--session-id <uuid>` (derived from the issue key), later ones use `--resume <uuid>`.

Claude Code does its own auto-compaction. Our transcript, compaction and prompt-caching code is not used by this backend.

### D5. Mapping Claude Code's signals to existing outcomes
| Signal | Outcome |
|---|---|
| Outcome file written by `ask_questions` | `questions` |
| Outcome file written by `finish` | `done` (implement) or `revised` (review) |
| `CLAUDE_CODE_MAX_TURNS` reached (`error_max_turns`) | `continue` (next session carries on) |
| Token budget for the segment exceeded (summed from stream usage) | `budget_exhausted` |
| `rate_limit_event` with a status other than `allowed`, or an error mentioning a usage limit | `rate_limited` with `retryAfterSeconds` from `resetsAt` |
| Ended without calling a terminal tool | One nudge via `--resume`, then treated as `questions` with its text |
| Any other error | Segment failure (the orchestrator retries, then FAILED) |

`rate_limited` is new. The orchestrator waits for the reset (a durable wait, so no compute), then starts the next session. It is bounded, and after a few in a row it posts a note and waits for a human.

### D6. Prompts
The same mode prompts apply (factory, OpenSpec, plain, visual-work guidance, trust boundaries), with backend wording: the terminal tools are `mcp__harness__ask_questions` and `mcp__harness__finish`, images are read with the Read tool, and reviewer subagents use Claude Code's own subagent tool instead of `run_subagent`. Claude Code also loads the repository's own `CLAUDE.md`, skills and commands natively.

### D7. Cost reporting
Claude Code reports `total_cost_usd` and token usage. For subscription sessions the cost section shows the session as "included in the subscription" with the API-equivalent value, and the total line says nothing is billed per token. The per-issue token budget still applies, counted the same way, as a brake on subscription usage.

### D8. Credential handling
The token comes from `claude setup-token`, is stored in Secrets Manager, read by the harness at segment start, and given to Claude Code through `CLAUDE_CODE_OAUTH_TOKEN` for that one process. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set so Claude Code strips credentials from the commands it runs. This has not been verified against a real run yet. Treat the token as readable by the agent until that is confirmed.

## Risks and Trade-offs

- **Not tested end to end until a real token is supplied.** The parser and runner are tested against the real event format (captured from the CLI), a fake `claude`, and the MCP server over real stdio. Resume behavior, the scrub flag, and real MCP use are unverified.
- **Subscription limits.** 5-hour and weekly windows can stop work mid-issue. `rate_limited` waits them out, but a long factory run may span several windows.
- **Terms of use.** Running a subscription token in automated server-side jobs is the operator's decision under Anthropic's terms.
- **Behavior differs.** Claude Code is a different agent loop with different tool behavior. Results will not match the Bedrock backend run for run.
- **Image size.** The CLI adds a few hundred megabytes. Launch time is unaffected (snapshot).

## Verified so far

- **Real event format.** Captured from the CLI (v2.1.316): `system` (init, hooks, session state), `rate_limit_event` (with `status`, `resetsAt`, `rateLimitType`), `assistant` (with `message.id` and usage), and a final `result` (with `subtype`, `is_error`, `terminal_reason`, `usage`, `total_cost_usd`, `num_turns`). The parser and the stand-in `claude` use these shapes.
- **Environment variables exist in the CLI:** `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `CLAUDE_CODE_MAX_TURNS`, `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER`. There is no `--max-turns` flag in this version, so the turn limit is set through the environment.
- **In a real MicroVM (image 21, ARM64):** Claude Code 2.1.317 runs as the unprivileged agent user, and without a token it returns an error result quickly instead of hanging. The harness MCP server, started from the deployed bundle as the agent user, answers `initialize`, `tools/list` and `tools/call`, and writes the outcome file.

## Open Questions

1. Does `--resume` work across VMs when only the config directory and cwd are restored? (Expected yes. To be observed.)
2. Does `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` fully hide the token from Bash tool calls? (To be observed.)

## Findings from the first supervised run (2026-11-03, mbonig/agreemint#54, OpenSpec mode)

Result: an issue ran end to end on a Claude subscription and opened a proposal pull request. Four defects had to be fixed first.

1. **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` needs `bubblewrap` and `socat` in the image.** Without bubblewrap Claude Code refuses to start. Without socat its Bash sandbox fails and every command is refused.
2. **The scrub flag forces the default permission mode.** `--dangerously-skip-permissions`, `--permission-mode bypassPermissions` and the `skipDangerousModePermissionPrompt` consent setting are all ignored. Claude Code prints "Permission mode forced to default" on stderr. The fix is an explicit `--allowedTools` list (including `mcp__harness`). The VM remains the sandbox.
3. **Authentication errors** are now classified as `BACKEND_NOT_CONFIGURED` and are not retried. The orchestrator sees failures as `CallbackExternalError`, so the code is placed at the start of the message and matched there.
4. **Segment stdout does not reach CloudWatch** beyond the start-up line. The harness now uploads its own log to `debug/<owner>/<repo>/<issue>/<segment>.log` in the transcripts bucket. It records the init settings, tool errors, and each run's result and stderr tail.

Open questions:

| # | Question | Answer |
|---|---|---|
| 1 | `--resume` across VMs | Worked. Segments 6 and 7 ran in separate VMs and continued the same session. |
| 2 | Scrub keeps the token out of Bash | Not yet checked. The flag is enforced (it needs the sandbox), but the `env` test has not been run. |
| 3 | Derived session id accepted | Yes. |
| 4 | Repo skills and `CLAUDE.md` | The `openspec-propose` skill loaded and ran. Factory skills not tried. |
| 5 | Reviewer subagents | Not tried (factory mode). |
| 6 | Token tally accuracy | Not compared yet. The PR cost section showed plausible figures. |

Still open: cost of failed attempts, proactive usage-window handling, a usage-window hit, a factory-mode run.
