---
name: shared-task-board
description: 'All open haive work lives in TASKS.md at the root of main (moved off the `tasks` branch 2026-10-24) — claim there (push HEAD:main = lock) before starting; check it before filing findings'
metadata:
  node_type: memory
  type: project
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-24T06:42:08.013Z
---

Since 2026-10-24 (user request) every session and machine works from ONE task board: `TASKS.md` at
the root of `main`. It started on an origin branch `tasks`; the user moved it to main the same day so
a checkout on another machine sees it (`tasks` now holds only a pointer, commit 8e88f5ff7). Board
edits are direct commits to main touching TASKS.md only — no PR.
Task numbers `T<n>` = the `#<n>` already cited in commits/PRs.

- Read: `git fetch origin main && git show origin/main:TASKS.md`.
- Edit: DETACHED worktree `<repo>/.claude/worktrees/tasks-board` on origin/main; always
  `git fetch origin && git rebase origin/main` → edit → `git commit -- TASKS.md` (one change) →
  `git push origin HEAD:main`. The push is the lock: rejected → fetch + rebase; if the task now has
  another owner, drop yours (reset only in that worktree). Never force-push main.
- Claim before any work (`status: taken · owner: <session>@<host> · since · last`); refresh
  `last:` on real progress; >48 h stale → ask the user before taking over.
- Findings: grep the board first; append to a task sharing files/rule (+N), else next free number.
  Design items are their own task. Done → delete block, one line in `## Done` (PR + merge sha).
- `## Areas` names files owned by other sessions (merge-resolver landing sections →
  modular-haive-plan; fnf/278-merge-dir-reads files until it lands).
- The board is a SYNC POINT, not a replacement for the session task tool (user, 2026-10-24): the user
  watches progress in the CLI task list. Mirror every board change in TaskCreate/TaskUpdate the same
  turn, put every session-created/finished task on the board, and at session start load your board
  tasks into the session list.
- The full protocol is in TASKS.md's header — re-read it there, it may have evolved.

**Why:** work moves between machines and several agents/sessions file findings in parallel; a
session-local task list dies with the session and duplicated/overlapping work happened before.
**How to apply:** at session start read the board; claim before starting; on merge move to Done.
Related: [[found-not-fixed-running-list]], [[fnf-items-as-tasks]].
