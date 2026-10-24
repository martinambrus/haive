---
name: background-watcher-cwd-worktree
description: A background gh/CI watcher started from a worktree dies silently in a retry loop once that worktree is removed; start watchers from the main checkout
metadata:
  node_type: memory
  type: feedback
  originSessionId: c7414b8d-5cd4-42f7-b0ef-f844f3671b7c
  modified: 2026-10-10T21:27:30.259Z
---

A background `gh run ...` watcher inherits the shell's cwd. Started from inside a `.claude/worktrees/<name>`
checkout and left running while that worktree is removed after merge, every `gh` call fails with
"failed to determine base repo ... Unable to read current working directory" and a polling loop
just retries until its cap, so nothing ever reports. MEASURED 2026-10-10: the main-CI watcher for
merge 5fb65cb8 sat ~30 min looking alive; the user had to ask what we were waiting for, while the
run had long since completed green.

**Why:** the user noticed a silent stall; a watcher that cannot fail loudly wastes their time.

**How to apply:** start long-running watchers with an explicit `cd /home/activit/haive &&` (or
pass `--repo martinambrus/haive` to every gh call), and remove a worktree only after the
watchers started from it have ended. Related: [[gh-run-watch-exit-status-lies]], [[remove-worktree-after-merge]].
