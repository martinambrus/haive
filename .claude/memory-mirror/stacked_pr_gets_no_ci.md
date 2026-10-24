---
name: stacked-pr-gets-no-ci
description: A PR opened against another feature branch gets NO workflow run and no automatic one after GitHub retargets it to main; close+reopen it
metadata:
  node_type: memory
  type: project
  originSessionId: 2c955f67-0a5a-47cb-b6fd-7506bd02d936
  modified: 2026-09-15T21:54:38.237Z
---

`.github/workflows/ci.yml` runs on `pull_request` into `main` only. MEASURED 2026-09-15 on #117:
opened with base `feat/tool-usage-schema`, the only check run was GitGuardian. When the base
branch was deleted by #116's merge, GitHub retargeted #117 to `main` silently, and that retarget
(a `pull_request: edited` event) started nothing either. `gh pr close N && gh pr reopen N` fired
the `reopened` event and CI ran (run `35027066791`).

**Why:** a stacked PR looks reviewable but is ungated, and the merge gate is CI green.
**How to apply:** stacking is fine for review scope, but after the parent merges check
`gh pr view N --json baseRefName`, then close+reopen before reading its checks. `rtk` summarises
`gh pr checks` into a fake "Passed: 1" line — read `gh run list --commit <full sha>` or the
actions API instead. Related: [[haive-pr-workflow]], [[gh-run-watch-exit-status-lies]].
