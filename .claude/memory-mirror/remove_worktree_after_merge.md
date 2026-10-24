---
name: remove-worktree-after-merge
description: "Remove the worktrees THIS session created as soon as their PRs merge (disk fills until WSL freezes); never touch another session's worktrees; never force a dirty one"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-09-25T11:19:56.906Z
---

Remove each worktree this session (or series) created right after its PR merges, as part of the
post-merge steps, and delete its local branch with the safe `git branch -d`. Only OUR OWN: stated by
the user on 2026-09-25, "we should just care about our own created worktrees, not other agents
working on this same project". Stated the same day about why: worktrees "take a lot of space on the
drive ... to the point when WSL has 0 bytes of disk space left and freezes the system"; the Windows
drive holding the WSL image had dropped from 200 GB free to ~35 GB in a week.

**Why:** WSL's `ext4.vhdx` and Docker Desktop's `docker_data.vhdx` grow and never shrink by
themselves, so space used inside WSL is gone from the host until the file is compacted. MEASURED
2026-09-25: removing 54 merged worktrees freed ~6 GB inside WSL (89 -> 83 GB used) while `ext4.vhdx`
stayed 155 GB on C:. That sweep also took 11 merged, clean worktrees of the parallel session
(`recovery-dag-archive-ci-fixes`, PRs #243-#264 and #257) — the mistake the "only our own" rule
exists to stop; nothing uncommitted was lost and that session was told.

**How to apply:** after each merge, remove that PR's own worktree. For a batch cleanup, restrict
the set to worktrees this series created (map branch -> PR number -> the series memory that owns
it; [[found-not-fixed-sweep-series]] for this one), then require the branch tip to be contained in
`origin/main` (`git merge-base --is-ancestor <tip> origin/main`) and `git worktree remove` to accept
it without `--force`. A merged tip with uncommitted changes is new work in progress
(`retry-claim-fence` on 2026-09-25) and is never forced. Also check a peer session is not merely
holding a fresh worktree whose tip still equals main. Related: [[haive-pr-workflow]].

**A watcher started inside a worktree you then remove exits 1 when it finishes.** Its final `pwd`
fails (`getcwd: cannot access parent directories`) after it printed `DONE`. Seen twice on 2026-09-25,
both over green CI. Read its output and the runs' conclusions from the API, never the exit code. If
the session's own directory is the worktree, first `cd` into another worktree this series keeps, then
remove it.
