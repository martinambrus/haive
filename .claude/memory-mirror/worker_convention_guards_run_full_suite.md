---
name: worker-convention-guards-run-full-suite
description: Source-scanning convention tests in packages/worker/test fail CI on a new git argv or temp name; run the whole worker suite before pushing one
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-09-26T14:51:27.282Z
---

`packages/worker/test/` holds tests that scan every `src` file for a convention, not behaviour:
`git-status-optional-locks.test.ts` (every `['status', ...]` argv literal must open with
`'--no-optional-locks'`, `GIT_OPTIONAL_LOCKS=0` in env does NOT satisfy it) and
`resource-naming-guard.test.ts` (every `haive-` literal must match `NOT_A_RESOURCE`, e.g. host temp
names reuse `haive-merge-snapshot-`). On #338 round 5 (2026-09-26) a new `git status` call passed
the targeted suites and turned CI red on the first guard.

**Why:** targeted runs (the changed file's tests plus neighbours) never load these scanners, and the
failure only shows 10+ minutes later in CI, costing a review round.

**How to apply:** before pushing a change that adds a git invocation, a temp path or any `haive-`
string, run the full worker suite (`node_modules/.bin/vitest run` in packages/worker, ~2-3 min,
399 files) — not just the touched files. Related: [[typecheck-with-package-script]].
