---
name: haive-remote-branches-auto-deleted-on-merge
description: "martinambrus/haive has deleteBranchOnMerge ON, so a merged PR's remote branch is gone immediately — `git branch -r` then lists stale LOCAL tracking refs, which reads as cleanup that is already done"
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-18T16:04:15.116Z
---

**`deleteBranchOnMerge: true` on `martinambrus/haive`.** MEASURED 2026-09-18 with
`gh repo view --json deleteBranchOnMerge`. Every merged PR's branch is removed from the remote at
merge time, by GitHub, with nobody running a delete.

Nothing local reflects that until a `git fetch --prune`. So `git branch -r` and
`git branch -r --merged origin/main` will happily list branches that **no longer exist on the
remote**, and that listing reads exactly like outstanding cleanup.

**Two misreadings this caused in one session, both avoidable:**

- I offered the user a list of six "stale remote branches merged into main, safe to delete now" and
  held it for their approval as an outward-facing action. All six were already gone; the list was my
  own stale tracking refs. The prune I then ran printed `[deleted]` lines that look alarming and are
  not — `git fetch --prune` NEVER deletes on the remote, it only drops local refs for branches that
  are already absent.
- `origin/feat/tool-usage-assigned` was in that listing and I had flagged it repeatedly as another
  agent's LIVE branch to preserve. It had merged as PR #161 ("feat(worker): record the personas
  Haive assigns to a run") at 08:36 the same day. A branch appearing in `git branch -r` is NOT
  evidence that anyone is working on it.

**How to apply:** before telling the user any remote branch needs deleting, run
`/usr/bin/git fetch --prune origin` and then `/usr/bin/git ls-remote --heads origin` — that second
command is the authoritative live list, read straight from the remote. Expect `main` plus the
`dependabot/*` set and nothing else; anything a PR merged is already gone. If a branch genuinely
does need removing, it will survive the prune.

A related tell: when instruction files are re-read mid-session and `AGENTS.md` has grown a paragraph
nobody in this session wrote, that is a merged PR's content arriving in main, not drift — #161's
`agents.assigned` / `assignedAgentIds` paragraph appeared exactly that way.

Related: [[haive-pr-workflow]] for how work lands here, and
[[gh-run-watch-exit-status-lies]] for the other case where a command's output is not the state.
