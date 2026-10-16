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
Pull; a task marked dead holds none), when the checkout has commits the source lacks or no history in common, and on a detached
HEAD; git itself refuses a fast-forward that would overwrite a local change, but not Haive's own pending projection files: those are set aside before the fast-forward and re-rendered over the new head (`setAsideHaiveProjections`, see [Onboarding template versioning](onboarding-upgrades.md)), and one that is not what Haive last wrote refuses the refresh naming the file. What the fast-forward wrote, run as root over a tree the sandbox user owns, goes to that user as a merge's does (`handBackAfterMove`, see [Merge conflicts](merge-conflicts.md)). The task check is read
twice: once under the claim, and again with the fast-forward itself under the project-state lock
(`lockProjectState`), and the set-aside reads it a third time under each of its own locks before it
touches a file, so a task that starts while the refresh fetches or waits for that lock, and an
upgrade still writing its record (which holds the same lock), keeps the checkout where it was. A same-branch merge reads the same check before it opens a merge in the checkout ([Merge conflicts](merge-conflicts.md)). A task
that starts after the fast-forward is not fenced out, since nothing that starts a task reads the claim:
the window writer 1 in [Onboarding reset](onboarding-reset.md) leaves open for the reset. It loses nothing
here either, since the fetch writes no working tree, the fast-forward stops at a change git sees and
the rebuild renames; what it can cost is a git lock collision that fails one side, which a Retry
clears. Before the checkout moves, a plan row stamped before migration 0196 takes its plan base from the plan.json still on disk (`seedPlanBaseFromCheckout`); a seed that fails fails the refresh and leaves a usable checkout where it was, since afterwards no Pull could recover that base. Only a checkout that is not usable (no `HEAD` at its own top level) is rebuilt, and whatever
stood there is renamed to a `<repoId>.aside-<time>` sibling first, never removed. A read-only folder
import is re-scanned as before, and a repository with no remote and no folder answers 409 without
touching its row.
