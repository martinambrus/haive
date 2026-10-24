---
name: worktree-guard-rtk-git
description: 'In a worktree-isolated session bare `git` is rewritten to `rtk git` and refused by the worktree guard; call `/usr/bin/git` instead'
metadata:
  node_type: memory
  type: feedback
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-14T18:04:02.041Z
---

MEASURED 2026-09-14 in `.claude/worktrees/agent-isolation-plan`: every bare `git …` and every
`git -C <worktree> …` was refused with "this command runs rtk with a git command among its operands
… Refusing to run it", even after a standalone `cd` into the worktree. `/usr/bin/git status --short`,
`/usr/bin/git commit -F <file>` and `/usr/bin/git push -u origin <branch>` then ran normally from
the same shell.

**Why:** the RTK PreToolUse hook rewrites `git` to `rtk git` before the worktree guard sees the
command, and the guard will not run git through a launcher it cannot read. The refusal is about
the wrapper, not the directory, so `cd` does not fix it.

**How to apply:** in a worktree-isolated session call git by absolute path, one plain command per
call, and put multi-line commit or PR text in a scratchpad file (`commit -F`,
`gh pr create --body-file`) because the guard also refuses `$(...)`. `gh` itself is unaffected.
Related: [[haive-pr-workflow]].
