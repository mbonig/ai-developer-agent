# Proposal: GitHub issue-to-PR agent on AWS

## Why

We want an autonomous coding agent that takes a GitHub issue, asks clarifying questions through issue comments, implements the change, opens a PR, and revises it in response to review feedback. Human replies may take anywhere from minutes to a couple of days. The system MUST NOT pay for agent compute while it waits for a human.

## What Changes

- Add a **GitHub App** installed org-wide. It receives `issues`, `issue_comment`, `pull_request`, `pull_request_review`, and `pull_request_review_comment` webhooks for every repo it is installed on.
- Add an **ingress Lambda** behind a Function URL. It verifies webhook signatures, filters out unauthorized authors and bot authors, queues comments in a per-issue inbox, and wakes or starts the orchestrator.
- Add a **per-issue orchestrator** built on **Lambda durable functions** (TypeScript). It sequences work segments and waits for humans through durable callbacks, with no compute charge while waiting.
- Add **work segments** that run in disposable **Lambda MicroVMs** (ARM64). Each segment rehydrates from external state (the WIP git branch and the S3 transcript), runs the agent loop, persists state, reports back, and is terminated.
- Add an **agent loop** that runs **Claude Code on an Anthropic subscription by default**. It uses file, search, and command tools, plus terminal tools to ask questions or finish. The Amazon Bedrock Converse API is an alternative, selected by an SSM parameter (deployment-wide) or an `agent-engine:bedrock` label (per issue). A maintainer can switch engines mid-issue with `/engine <provider>` or a label, and the new engine continues from a rebuilt handover.
- Add **DynamoDB** for issue state and the comment inbox, and **S3** for agent transcripts.
- The agent starts only on issues carrying a configured label (default `agent`). Only comments from OWNER, MEMBER, or COLLABORATOR authors are acted on.
- After opening the PR, the agent stays attached. PR conversation comments and review comments wake it to push revisions. Its lifecycle ends when the PR is merged or closed, or when the issue is closed.

## Capabilities

### New Capabilities

- `github-integration`: GitHub App registration, webhook ingress and verification, author authorization, event routing, and installation-token vending.
- `issue-state`: Per-issue state record, status and phase model, the comment inbox with queue semantics, and race-free wake/park transitions.
- `orchestration`: The durable-function lifecycle per issue: start, segment loop, human waits, debounce, expiry and resume, PR creation, the review phase, and cancellation.
- `work-segment`: MicroVM image, launch, job handoff, rehydration, persistence, result reporting, termination, timeouts, and the orphan sweeper.
- `agent-loop`: Model provider selection (Claude Code subscription by default; SSM or issue-label override to Bedrock), the tool-use loop, tool set, prompts, transcript persistence and compaction, budgets, and secret isolation.

### Modified Capabilities

None. This is a new system.

## Impact

- **New AWS resources** (CDK, TypeScript): Lambda functions (ingress, token vending, orchestrator, sweeper), a Lambda MicroVM image, a DynamoDB table, an S3 bucket, Secrets Manager, and IAM roles.
- **New GitHub App** with Contents, Issues, and Pull requests read/write, and Metadata read. It must be installed on target repos.
- **Anthropic subscription:** a Claude subscription OAuth token (`claude setup-token`) is required for the default provider. Bedrock model access is required only if Bedrock is selected.
- **Region constraint:** the deployment region must support both Lambda MicroVMs and Lambda durable functions.
- **Cost drivers:** model usage (dominant; covered by the Anthropic subscription by default, billed as Bedrock tokens only for issues that select Bedrock), MicroVM active time, durable operations, DynamoDB, and S3. Waiting time costs nothing for compute.

## Non-Goals (v1)

- Running repos that require x86-only binaries, Docker, or external service dependencies (databases, etc.) during the build or tests.
- Resolving merge conflicts with the default branch automatically.
- Acting on edited or deleted comments.
- Restricting network egress from segments.
- Letting maintainers raise a budget-exhausted issue's budget through a comment.
