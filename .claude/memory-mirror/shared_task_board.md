---
name: shared-task-board
description: 'All open haive work lives on origin branch `tasks`, file TASKS.md — claim there (push = lock) before starting; check it before filing findings'
metadata:
  node_type: memory
  type: project
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-24T06:42:08.013Z
---

Since 2026-10-24 (user request) every session and machine works from ONE task board: branch
`tasks` on origin, file `TASKS.md`. It is never merged into main (edits run no CI, touch no PR).
Task numbers `T<n>` = the `#<n>` already cited in commits/PRs.

- Read: `git fetch origin tasks && git show origin/tasks:TASKS.md`.
- Edit: worktree `<repo>/.claude/worktrees/tasks-board` on branch `tasks`; always
  `git pull --rebase origin tasks` → edit → commit (one change) → `git push origin tasks`.
  The push is the lock: rejected → pull --rebase; if the task now has another owner, drop yours.
  Never force-push.
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
