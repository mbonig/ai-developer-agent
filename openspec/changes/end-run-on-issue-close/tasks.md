# Tasks

- [x] 1. Route `pull_request.closed` as `prFinished`; `issues.closed` stays the only cancel.
- [x] 2. `unlinkPr` in shared state; per-pull-request branch names.
- [x] 3. Orchestrator ends cancelled runs as `DONE`.
- [x] 4. Restart from `DONE` as well as `CLOSED` and `FAILED`.
- [x] 5. Ingress comments on dropped comments and relabels (token vendor access in the ingress stack).
- [x] 6. Factory mode uses `factory/gh-<n>-<k>` for later pull requests.
- [x] 7. Tests for routing, ingress, state, harness, and a second pull request after a merge.
- [x] 8. README: diagram, state text, restart text.
