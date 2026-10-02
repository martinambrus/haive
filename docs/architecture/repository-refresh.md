# Repository refresh

**Refresh brings a checkout up to its source and never deletes one.** `POST
/repos/:id/refresh-tree`, which the repos page offers as Retry on a repository in `error`, used to
enqueue the clone or copy job, and both remove the root before anything else: MEASURED, a clone
holding one unpushed commit lost it, and every task worktree under `.haive/worktrees` went with the
tree. `handleRefresh` (`repo/refresh.ts`, claim kind `refresh`) fetches the checkout's branch from
its source and runs `merge --ff-only`. The source is `origin` with the stored credential or, for a
writable folder import, the host folder itself (the user's call: that copy carries Haive's own
onboarding output, and the folder often has no remote). It refuses, saying why beside a `ready`
repository, while a task holds the checkout (`CHECKOUT_HOLDING_TASK_STATUSES`, shared with plan
Pull), when the checkout has commits the source lacks or no history in common, and on a detached
HEAD; git itself refuses a fast-forward that would overwrite a local change. The task check is read
once, under the claim, and nothing that starts a task reads the claim, so a task that starts during
a refresh is not fenced out: the window writer 1 in [Onboarding reset](onboarding-reset.md) leaves open for the reset. It loses nothing
here either, since the fetch writes no working tree, the fast-forward stops at a change git sees and
the rebuild renames; what it can cost is a git lock collision that fails one side, which a Retry
clears. Only a checkout that is not usable (no `HEAD` at its own top level) is rebuilt, and whatever
stood there is renamed to a `<repoId>.aside-<time>` sibling first, never removed. A read-only folder
import is re-scanned as before, and a repository with no remote and no folder answers 409 without
touching its row.
