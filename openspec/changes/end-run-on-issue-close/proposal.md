# Proposal: end a run when the issue closes, not when a pull request merges

## Why

A run went `DONE` as soon as its pull request merged, and `DONE` was final. An issue can need more than one pull request. On mbonig/ethr-hunt#70 the first pull request (the PWA half) merged, the run ended, and the Flutter follow-up was never picked up. A comment and a relabel both did nothing, and the agent said nothing back.

## What Changes

- A pull request merged or closed no longer cancels the run. It unlinks the pull request, sets the phase back to `IMPLEMENT`, and moves the run to a fresh branch. A waiting run stays waiting. A running segment keeps running.
- `issues.closed` is the only event that ends a run, and it ends as `DONE`.
- A later comment on the issue starts the next pull request. Each pull request has its own branch: `agent/issue-<n>` for the first, `agent/issue-<n>-<k>` for the k-th (`factory/gh-<n>-<k>` in factory mode).
- Relabeling restarts a run that is `DONE` (the issue was closed and reopened), as it already did for `CLOSED` and `FAILED`. `BUDGET_EXHAUSTED` is unchanged.
- When a comment or relabel is dropped because the run has ended, ingress posts a short comment on the issue saying why.

## Decisions

- `CLOSED` and `DONE` now mean the same thing. Both statuses are kept, and both restart. New runs only ever end as `DONE`. This is the smallest change and leaves existing records valid.

## Impact

- Supersedes the requirement "Lifecycle termination events" (orchestration) and adjusts "Status and phase model" (issue-state) and "Event routing" (github-integration).
- Existing `DONE` records from a merge do not migrate. They restart on relabel, but still point at the merged pull request until `prNumber` is removed and `phase` set to `IMPLEMENT`.
- The agent's pull request body still says `Closes #<n>`. GitHub closes the issue when such a pull request merges, which ends the run. Repositories that want several pull requests per issue need the follow-up pull requests to say `Refs` instead.
