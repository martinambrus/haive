---
name: conflicted-pr-gets-no-ci
description: "A PR with merge conflicts silently stops getting CI runs, and the run named `PR #<n>` is CodeQL rather than the repo's CI — so a watcher can report green while the real suite never ran"
metadata:
  node_type: memory
  type: reference
  originSessionId: dc11f5ec-28cf-424a-91d6-7d4fd9d94812
  modified: 2026-09-22T17:29:38.415Z
---

Haive's `CI` workflow triggers on `pull_request: branches: [main]`. When a PR CONFLICTS with
main, GitHub cannot build `refs/pull/N/merge`, so it creates **no run at all** — not a
cancelled one, not a failed one. `gh run list --commit <sha>` then returns only the CodeQL
dynamic workflow, whose `name` is literally **`PR #<n>`**, and a watcher that treats "all runs
completed and successful" as green reports green while the repo's own suite has not run.

**Why:** MEASURED 2026-09-22 on #210 — two pushes produced no CI while another branch's CI ran
normally in the same window, and `gh pr view --json mergeable` answered `CONFLICTING` /
`DIRTY`. `mergeable` is computed lazily: the FIRST call right after a push answers `UNKNOWN`,
so ask twice.

**How to apply:** filter by workflow (`gh run list --workflow=CI`), and treat **no CI run** as
a distinct state from green or red — it almost always means the PR needs main merged in.
Check `gh pr view <n> --json mergeable,mergeStateStatus` at the first sign of a missing run.
Resolve with `git merge origin/main` on the branch, never a rebase (see [[haive-pr-workflow]]).
`UNSTABLE` after the merge just means checks are still running.

Watcher that keys on this correctly:
`/tmp/claude-1000/-home-activit-haive/<session>/scratchpad/watch-pr.sh`.
