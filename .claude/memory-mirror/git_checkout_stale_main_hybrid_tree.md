---
name: git-checkout-stale-main-hybrid-tree
description: 'Switching the bind-mounted dev checkout to a STALE local main rewrites the tree to old content first; use `checkout -f -B main origin/main` or reset, after checking `rev-list --left-right --count main...origin/main`'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 77d92749-e3c7-4fa7-994c-1a80fed4b544
  modified: 2026-10-08T08:03:16.188Z
---

On 2026-10-08, to move the dev checkout off a stale branch, I ran `git checkout -f main && git merge --ff-only
origin/main`. Local `main` was 35 commits behind `origin/main`, the working tree already held `origin/main`'s
content, and 41 files were untracked copies of main's newer files. `checkout -f main` rewrote every tracked file to
OLD main content, then the fast-forward aborted ("Aborting") because the untracked files stood in its way. The
bind-mounted tree was a hybrid (old tracked files, new untracked ones) for about a minute: the worker logged
`SKIPPABLE_STEP_IDS out of sync with StepDefinition.metadata.allowSkip` and restarted twice, the api twice.
`git reset --hard origin/main` repaired it, and the worker came back `ready`. No task was running, so nothing was lost.

**Why:** the stack watches this tree, so any intermediate state is live. The failure was the ORDER: I had already
measured the 35-commit gap and still treated checkout and fast-forward as one atomic step.

**How to apply:** before moving the dev checkout, run `git fetch` and `git rev-list --left-right --count
main...origin/main`. If local `main` is behind, go straight to the target in one command (`git checkout -f -B main
origin/main`, or `git reset --hard origin/main` once on `main`), never through the stale ref. First prove no unique
work: `git diff origin/main --shortstat` empty plus a byte comparison of any untracked files
(`git hash-object` against `git rev-parse origin/main:<path>`). Check running tasks first, and read the worker log
afterwards ([[haive-worker-tsx-watch-goes-stale]], [[worktree-resolves-shared-from-main-checkout]]).
