---
name: fresh-worktree-skips-lint-staged
description: "A commit from a worktree that has no node_modules runs no lint-staged, so unformatted files reach CI's format check"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f5017f4f-0dce-49e2-af7e-9b3e0ca76aaf
  modified: 2026-10-14T16:36:44.859Z
---

A fresh `git worktree add` has no `node_modules`. Committing from it runs no lint-staged hook
(prettier never runs) and `pnpm exec prettier` fails silently when its output is discarded, so an
unformatted file (a README table row) reaches CI and the "Format check" step goes red.
MEASURED 2026-10-14 on PR #697 (D1c): README.md failed `pnpm format:check` in CI after a commit
from such a worktree.

**Why:** the hook and prettier live in the worktree's own `node_modules`; nothing warns when they
are missing.

**How to apply:** in a new worktree, run `pnpm install --offline --frozen-lockfile` before the first
commit (builders already do this before building), and run `pnpm format:check` before pushing a
change made in a worktree that never installed. Related: [[worktree-breaks-format-check]].
