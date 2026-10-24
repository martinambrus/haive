---
name: worktree-breaks-format-check
description: 'A .claude/worktrees/ copy makes `pnpm format:check` report ~34 phantom failures; they are never yours'
metadata:
  node_type: memory
  type: project
  originSessionId: 1a595d22-2abc-452d-be02-6ee8d9a0327f
  modified: 2026-09-12T13:46:35.374Z
---

While a `.claude/worktrees/<name>/` worktree exists, `pnpm format:check` fails with ~34
`docs/plans/*.md` warnings under that worktree path.

**Why:** `.prettierignore` lists `docs/plans` as a bare path, which prettier anchors to the
repo root. The worktree's copy sits at `.claude/worktrees/<name>/docs/plans/`, so the pattern
does not match it and prettier formats files the root checkout deliberately excludes (those
plan files are hand-written and must not be rewritten — see `docs/plans/README.md`).

**How to apply:** before treating a red `format:check` as yours, run
`pnpm format:check 2>&1 | grep '^\[warn\]'` and discard every path under
`.claude/worktrees/`. CI clones fresh and has no worktree, so these can never fail there.
`benchmarks/README.md` and `packages/web/.vitest/json/output.json` also show up and are
likewise not yours — a local edit and a test artifact.

**FIXED 2026-09-22 in PR #214.** `.prettierignore` now lists BOTH worktree roots, so the workaround
below is only needed on a checkout predating that. MEASURED before it: 81 files flagged, 80 of them
worktree copies, 1 real. The noise was never the point — `pnpm format`, the WRITE twin of the same glob,
was rewriting files that belong to another branch's checkout.

`.haive/worktrees` is the dangerous half and was missed on the first pass: it is where Haive's own
`01-worktree-setup` puts a RUNNING task's feature branch (`repo/worktree-paths.ts:5`), and it is excluded
through `.git/info/exclude` rather than `.gitignore`. Prettier reads NEITHER — its ignore defaults are
`.gitignore` and `.prettierignore` — so it was invisible to `git status` and fully visible to prettier.

**Three measurement traps, all of which produced confident wrong answers:**

- a `--ignore-path` pointing at a file in `/tmp` resolves that file's relative patterns against `/tmp`,
  so every repo pattern silently stops matching (1209 files "unformatted");
- passing ONE `--ignore-path` drops prettier's other default, `.gitignore`, exposing every ignored
  artifact (1086 files). Pass both explicitly when comparing;
- `--file-info` answers for a path that does not exist, and combined with repeated `--ignore-path` it
  prints the file's CONTENTS instead of the JSON verdict. The trustworthy test is to create the
  directories for real, ask `--file-info`, and delete them.

Removing the worktree (`git worktree remove <path> --force`) still clears it on an old checkout. Related:
[[haive_host_build_restarts_worker]] is why a worktree gets created in the first place.
