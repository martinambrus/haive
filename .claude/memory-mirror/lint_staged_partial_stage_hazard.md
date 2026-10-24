---
name: lint-staged-partial-stage-hazard
description: "Splitting one file across several Haive commits can corrupt the worktree — lint-staged's unstaged-restore mis-applies after prettier reflows"
metadata:
  node_type: memory
  type: project
  originSessionId: 78fe9449-e64f-48a9-a3d7-9812a3fe7242
  modified: 2026-09-04T11:04:21.740Z
---

Haive's pre-commit runs lint-staged with `prettier --write`. When a file is only
PARTIALLY staged (one file's changes split across several commits), lint-staged stashes
the unstaged remainder, prettier reflows the staged content, and the restore then applies
the remainder at a shifted location. On 2026-09-04 that spliced a new `const` block into
the middle of an adjacent `/** ... */` doc comment in `step-runner.ts`, producing
`TS1003` / `TS1161`.

**Why:** the corruption lands in the WORKTREE, not the commit, so the commit that
triggered it looks fine and the damage surfaces on the _next_ one — after you have moved
on.

**How to apply:** when building commits from partial stages, run
`pnpm --filter <pkg> exec tsc --noEmit` on the worktree after EVERY such commit, before
staging the next. Verify the commits already made are intact with
`git show <ref>:<path> | diff -w - <intended-stage-file>` (expect formatting-only deltas)
rather than assuming they are.

Staging without touching the worktree is what makes the split safe in the first place:
`sha=$(git hash-object -w <stage-file>); git update-index --add --cacheinfo 100644,$sha,<path>`.

Related: [[haive-pr-workflow]], [[haive-ship-cycle]].
