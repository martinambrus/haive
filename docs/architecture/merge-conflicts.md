# Merge conflicts

The DAG's level merge and the merge resolver (`12-worktree-cleanup`, `00a-sync-base`,
`13-onboarding-push`) share the git core in `git-merge.ts`. Each fix agent edits the conflicted
files, and the host verifies, stages and commits, so a fixer must never start from what an earlier one
left. Six rules keep it that way, each MEASURED on git 2.43 and 2.54:

- **Unmerged paths are read with `-z`** (`unmergedPaths`). Without it git quotes a name holding a quote
  or a non-ASCII byte, the quoted name reads as a deleted file, and its conflict markers were committed.
- **A conflict is told from a refused merge by MERGE_HEAD naming the merged ref** (`openMerge`). A
  refusal (a local change or an untracked file in the way, a ref git cannot resolve) opens nothing and
  exits with the codes a conflict does, and used to send fixers into a tree with no merge in it. It
  now halts with git's own reason.
- **`merge --abort` refuses once a file the merge staged is edited**, a fixer's edit to a cleanly
  merged file, and used to leave that half merge for the next fixer. `abortMerge` puts those paths
  back from the index, each by its bytes, and aborts again. An abort that still fails halts the step
  with a `merge.abort_failed` event, and nothing is dispatched into the merge. A merge open for
  another ref is an earlier attempt's and is aborted before a new one opens.
- **A person's own checkout is never written to.** The worker's `/host-fs` mount is read-write, so under
  `HOST_REPO_ROOT` nothing is put back from the index and a merge open for another ref is left alone:
  both halt and name what blocks them.
- **A merge dir holds one task's merge at a time, by a claim and fenced sections.** A cross-branch
  merge runs in a worktree named from the base branch alone (`main--base`), shared by every task
  merging into that base, since git allows the branch in one worktree. A step takes the dir in
  `merge_dir_claims` (one row per dir, `claimMergeDir`) before its first git write there, under
  the dir's advisory lock (`inMergeDirLock`, key `hashtextextended('merge-dir:<mergeDir>', 0)`), in
  a transaction of its own so the claim is committed ahead of the writes it covers. The claim is the
  same step's again on a re-entry, a Retry or a base-sync round, and the same task's from an earlier
  step. Another task's claim halts the step, naming that task, without touching its merge; the Retry
  asks again. It is released only by the owning pass, in the section that removes the base worktree
  and records `done`; by `handleCancelTask` once a docker listing shows no cli sandbox of the task left (the cancel
  first marks every unended run of the task superseded, so one still queued refuses to create its
  sandbox after the listing, and the listing counts created sandboxes as well as running ones; a run
  that read its last superseded check just before the cancel and creates its sandbox just after the
  listing is still missed, until the superseded poll stops it within 5 s; running-list item #262)
  (`releaseTaskMergeClaims`, each claim deleted under its dir's lock, so a section the old pass is
  inside finishes first), since the cancel commits before the fixer it ran is stopped; a listing that
  fails, times out or still shows one keeps the claims, skips the dir-touching teardown and the
  finish record, and fails the CANCEL job for the stalled re-drive; or by the foreign key when the
  task goes. A completed task, a
  skipped step, or a cancelled task whose `task.cancel_finished` event exists is stale: the next
  claim takes the row over and its abort cleans the leftover. The event is written after the
  release, so it also covers a claim that committed after the release read the task's claims; a
  cancelled task without it still holds, since its fixer may still be running. A
  failed task keeps the claim, since its Retry resumes the merge it left open, and so does a crashed
  worker's, which boot re-drives. Every host-side write to the dir in `merge-resolver.ts` runs in
  `withMergeDirSection`: one transaction that holds the lock, reads the claim FOR UPDATE and requires
  it to be this step's, checks with a plain read (`taskWriteTarget`: the pass's epoch, and not
  failed, cancelled or completed) that the task is still live, and refuses with `StepSupersededError`
  before `fn` runs. The task row is not locked: a lock there deadlocked with a Retry, which writes
  its step rows before the task row. A Cancel, Retry, Skip or Stop lands on the task row at once and does not
  interrupt a section in flight; every section that starts after it, including one already queued
  on the lock, reads the task as moved on and is refused, and the cancel's release waits for the
  section in flight. Waiters poll
  `pg_try_advisory_xact_lock` in a fresh short transaction per attempt (100 ms doubling to 1 s), so
  none holds a pooled connection between attempts (the pool is 10; blocking waiters starved it and
  the holder's own pool write). `fn` writes the database through its `tx` only: a pool write waits
  on a row the section holds, and the step row is never locked (a pass's own `updateOwnedStep` would
  wait on it). Reads a section needs (the secret-mask
  policy, the squash message, a fetch credential) are made before it. The squash saves `squashing` in
  a section of its own ahead of the reset, so a crash between the reset and the commit re-enters it.
  The push runs outside a section, since it is network-bound, and sends the commit a section read
  from the base ref (`<sha>:refs/heads/<base>`, with the upstream set afterwards; a failed upstream setup does not fail the push, it is logged and
  added to the step's warning), so a pass that
  lost the dir can push only what it merged. The directory is keyed rather than the repository
  because two repository rows can share one local path. The DAG executor needs none: its integration
  worktree is the task's own feature worktree, which `findBranchClaimant` keeps to one task.
- **What a fixer changes outside the conflicted files is moved aside, never committed or lost.**
  Before a fixer is sent in, the merge dir is recorded as one git tree built in a scratch index,
  untracked files included, with what the merge staged (a tree built from
  `diff-index --cached HEAD`, so its cost follows the merge, and written through
  `update-index --index-info` on stdin, so a name that is not UTF-8 keeps its bytes), the paths it
  is sent to resolve, `HEAD` and `MERGE_HEAD` (`captureFixBaseline`, 1.8 s cold on a 39,378-file
  repository). Every listing these read is bounded at 64 MiB rather than execFile's 1 MiB default,
  which 300 changed paths under a deep directory pass, and a listing cut short checked nothing. For
  a directory/file conflict those paths include the one git moved the file away from: git gives the
  file a name of its own (`foo~HEAD`), reports only that and stages the directory side, so keeping
  the file means deleting the directory and putting the file back (MEASURED on git 2.43 and 2.54).
  The partner is found by content, the same blob beside it on its side where the other side holds a
  directory, never by the name git chose, and only where that side changed it since the merge base:
  git takes the directory cleanly where it did not, so an identical sibling is no partner. Files git
  ignores are left out and stay where a fixer leaves them, never committed: they are where a
  person's running tools write (build output, logs, caches), and recording them would hash every
  dependency tree, MEASURED at 43,305 ignored files (835 MB of `node_modules`) beside 1,972 tracked
  in a worktree of this repository. What counts as ignored is settled then, kept as a blob
  (`git status --ignored=matching`, which names a directory only when a rule ignores the directory
  itself: 26 entries for those 43,305 files). A fixer resolving `.gitignore` otherwise made a file
  under a rule it dropped read as new and be moved, and hid a recorded file under a rule it added,
  which the restore then wrote over (MEASURED on git 2.43). So the tree taken once it ends starts
  from the recorded one, and only a file new since is judged by the rules it leaves; a `.gitignore` moved aside and
  put back is followed by a second snapshot, so a file only the fixer's own rule hid is moved too. While secret
  masking is on (the default), the deny-list's files (`.env`, `.env.*`) that the merge's own index
  does not track are read-only empty mounts in the fixer's sandbox, so it cannot change those, and
  such a file is left out of both snapshots, masking on or off: at a same-branch root the sandbox
  holds `.git`, where a snapshot's blob would hand the fixer back what the mask hides. One the merge
  added is tracked there, so the sandbox leaves it readable and both snapshots read it. Both
  snapshots and the restore read
  `.gitattributes` from the empty tree (`GIT_ATTR_SOURCE`, git 2.40) with `core.autocrlf` off and
  `core.fileMode` on, so no clean filter or line-ending conversion stands between the bytes recorded
  and the bytes put back, and a change of the executable bit is seen where the repository ignores
  modes (MEASURED on git 2.43 and 2.54: otherwise a lossy clean filter's output came back, and LF
  for CRLF). That bit is the only permission git records, so a fixer's other permission changes are
  neither compared nor reported: recording them would take a walk of the whole tree before and after
  every fixer, and setting modes to git's view would widen a person's own 0600 files. Once it ends,
  on every outcome and before the merge is committed or aborted, whatever it changed outside those
  paths moves to `.haive/merge-leftovers/<task>/<run>/files/` beside a `manifest.json`, and the
  paths are put back from the tree (`relocateFixerChanges`). git recreates a file it puts back with
  its default mode, so each keeps the permission bits of the file it replaced, never wider than git
  wrote it, the executable bits following git where reading is allowed: a person's own 0600 file
  came back 0644. A deletion there is put back too, and reported like a move, since at a same-branch
  root it can be the person's own. The commit then
  stages only the paths the fixer was sent to resolve, so neither a stray nor a person's own
  uncommitted work at a same-branch root is swept into it, where `add -A` took both. What a fixer
  staged itself outside those paths is put back in the index as the merge had it, byte for byte so a
  name that is not UTF-8 is unstaged too, `.haive-data/` and gitlinks included although they stay in
  the tree, since `commit` takes the whole index and a fixer at a same-branch root can run git;
  MEASURED on git 2.43, git refuses to open a merge while the index holds a staged change, so the
  recorded index is the merge's own, and the manifest names each blob taken out. An index that
  cannot be read, or that still holds what the fixer staged after a few tries (another git process
  holding its lock), stops the step before anything is committed, and the recorded tree is kept for
  the retry. The index is put back even when the tree cannot be read (a mask policy, snapshot or
  diff that fails), since it needs only the recorded index. A person's own edit made there while the
  fixer ran cannot be told from the fixer's and is moved with it. The index is refreshed after the
  restore, since git rewrites the files and `merge --abort` refuses their stale stat data. git
  writes what it puts back as the worker, so those paths, and the directories git created for them,
  are handed back to the merge dir's owner; a directory that already stood keeps its own. The merge and
  the abort are handed back the same way (`openMerge`, `abortMerge`, which the plan merge's
  `mergeOriginInto` and `abortMerge` go through too): run as root over a tree the sandbox user owns, git writes a conflicted file and a directory it creates as root, which a fixer
  cannot rewrite or add to (MEASURED). The paths that differ from the commit before the merge, or
  from `HEAD` before the abort, and the directories above them that root owns, go to the sandbox
  identity (whoever owns the tree, since a tree the sandbox reaches through its mode bits is accepted
  as it stands), one `diff --name-only -z` per call, and the index is refreshed since a chown moves ctime and
  `merge --abort` refuses stat data that moved; a name that is not UTF-8 stays the worker's and is
  logged. A fast-forward of the checkout is handed back the same way from the commit before it
  (`handBackAfterMove`): 00a's on the checked-out branch, a repository refresh's, and `landPlanMerge`'s
  for a plan Pull, Save or confirm. In the checkout, Haive's projection files and their directories
  (`.haive-data/state/**`, `plan.json`, `plan.md`) are left out of all three hand-backs: the worker
  writes them, and `restoreKeptMetadata` restores the owner and mode a set-aside captured only on a
  file the worker still owns. A worktree is never set aside, so there they are handed back like any
  other path; `knowledge_base/` and `learnings/` are handed back everywhere. `.haive/`,
  `.haive-data/` (other writers keep them) and gitlinks are never moved; a link or a name that is
  not UTF-8 stays and is reported, a link with its target in the manifest, since a scratch worktree
  removed later takes the link with it. A name is judged by its bytes (the plan merge's
  `conflictedPaths` too), since a valid one can hold U+FFFD, the character an undecodable byte reads as. A directory a fixer made where a file stood
  gives way to the file only once everything in it has moved: git replaces such a directory whole
  and takes what is left in it along, so one still holding something is kept and named. The recorded
  tree is spent once used, and one whose merge a person finished or aborted meanwhile moves nothing:
  putting its paths back would write merged files into a tree with no merge open. A tree git could
  not record is reported the same way rather than read as a fixer that changed nothing; the fixer is
  still sent, since halting there would stop every merge whose scratch `add` fails (a clean filter
  the worker lacks). Each relocation is a `merge.fixer_leftovers` event and a step warning. Its
  manifest is written before anything moves and marked once that event is written (a `reported` file
  beside it), so a relocation a restart cut short, or one whose event was never written, is reported
  by the task's next relocation. A base worktree is removed without `--force`, so one still holding
  something git will not discard is kept and named. The plan merge's agent pass (`01-plan-merge`) is
  handled the same way, its note going into the conversation rather than a step warning, since the
  revise loop resets the row every turn. Its recorded tree is kept for the whole merge rather than
  spent, as a `plan_merge.fix_baseline` task event beside the transcript, since a Retry resets the
  row and the next conversation resumes a merge a failed one left open. Nothing but its fixers
  writes in the scratch worktree, so what one that failed, was stopped or was re-dispatched left is
  moved aside before the next is sent in (`llm.prepareWorkspace`) and before Save or Pull removes
  the worktree, reported by the event alone; Save or Pull fails and keeps the worktree when that
  cannot be done. A tree git could not record is kept the same way, so every later fixer of that
  merge is reported unchecked, a later pass's before its fixer is sent in, rather than a fresh
  record taking in what one left. A merge a pass opens is recorded afresh, since an earlier merge of
  the same two commits was another tree. A conversation that resumes another's merge also reports
  what that one's relocations never did. Nothing is recorded under `HOST_REPO_ROOT`: the sandbox
  mounts a local-path repository read-only, so no fixer can write there. A cancel runs no step
  code, so it moves nothing aside: a task's worktree is removed whole, a fixer's changes with the
  rest of the task's work, and a same-branch root is left as the fixer left it, merge still open.
  That open merge is reported, never settled on its own, since a cancel cannot prove the merge
  open in a directory is the task's. Before it releases its claims, and under each directory's lock, the CANCEL
  appends a `merge.left_open` event `{dir, ref, head, mergeHead}` for each directory a merge step in
  `resolving`, `pending`, `awaiting-guidance` or `squashing` (or a DAG level with a conflict in
  flight, in the task's integration worktree) recorded, and only where MERGE_HEAD is the commit of
  the ref it was merging and the directory is not a host checkout (`isHostCheckout`, a person's own); one per directory and merge head, so a re-driven cancel adds none. The task
  page shows it with an "Abort merge" button behind a confirm (`POST /tasks/:id/merges/abort`, owner
  only, cancelled tasks only, naming a directory an unsettled event reports). The worker job
  (`abortLeftMerge`) runs under the directory's lock and records `merge.left_open_settled`
  `{dir, mergeHead, outcome, reason}`: `refused` while a live task's `merge_dir_claims` row holds the
  directory (`liveClaimHolder`, the staleness rules `claimMergeDir` uses), `moved` with nothing
  aborted when HEAD or MERGE_HEAD are no longer the reported ones, otherwise the fixer's changes outside
  the conflict are moved aside if a `fixBaseline` for that head and merge head is still recorded
  (reported unchecked when not) and `abortMerge` ends the merge. A `refused` outcome (a live holder,
  an abort git refused, a job that threw) leaves the report open with the reason shown and the button
  offered again; `moved`, `aborted` and `aborted-by-next` close it. For a same-branch merge both
  `moved` and `aborted` also put back the projections its set-aside moved away, with the owner and
  mode it kept (`settleProjections`), and a `moved` reason then says so; a put-back that throws, or
  whose re-sync did not finish, fails the job, which is retried rather than settled, so the report
  stays open until the owner and mode go back. A cancel that finds such a merge already
  gone reports nothing but puts the files back the same way at once. A failure while recording a
  report throws, so the cancel is re-driven before `task.cancel_finished`; the page polls until that
  event is in and no abort it sent is still waiting. A resolver that clears a stale
  merge before opening its own first moves that task's fixer changes aside under its report
  (`relocateLeftOpenFixers`, halting instead while the index still holds what the fixer staged),
  then (`peekOpenMerge` before the abort, `noteAbortedByNext` after) settles
  the report of the same directory, head and merge head with `aborted-by-next` and warns on its step;
  for a same-branch merge it first takes what that task's set-aside kept into its own state
  (`takeLeftOpenKept`), so its own end restores those files' owner and mode.
  A cancelled plan merge is the exception (`discardPlanMerge`, from `handleCancelTask`): the worker
  moves aside what the recorded fixers left, aborts the merge and removes the scratch worktree,
  unless another `plan_merge` task of the repository holds it, a live one or a failed one opened after it
  (`plan_merge.discard_skipped`),
  and a move that fails keeps the worktree (`plan_merge.discard_failed`).

Haive's own files merge before any fixer or person sees a conflict. Right after the merge opens, and
again when a Retry reopens it, the resolver runs `resolveHaiveProjectionConflicts` (the plan merge's
three-way merge of `.haive-data/plan.{json,md}` and of the `.haive-data/state/` record) in the merge
dir. A merge left with nothing else unmerged is committed host-side and finishes as a clean one does,
with no fixer and no form; otherwise the list the fixer and the clarification form get omits the
paths already resolved. A side it fell back on is logged and added to the step's warning. The fixer
prompts (the three merge steps' and `01-plan-merge`'s) say to leave exactly the files the resolver
merges alone — `.haive-data/plan.json`, `plan.md` and `.haive-data/state/` (`HAIVE_OWN_FILES_LINE`);
any other Haive path that conflicts stays the fixer's to resolve, or the merge could never close. The DAG level merge does not do this yet, so its prompt omits the line.

The resolver checks for a committed merge before its budget halt, so a merge finished by hand after
a halt finishes the step on a Retry.

A worktree that holds uncommitted work is never removed without an explicit choice. Merging takes
only what was committed, and removal deletes the rest, so `12-worktree-cleanup` reads `git status
--porcelain=v1 -z` (`readUncommittedChanges`, `repo/worktree-changes.ts`): when the tree is dirty,
or git cannot read it, its form lists the paths, defaults to Keep, and removes only when "Delete the
N uncommitted changes" is ticked; apply reads the status again right before removing. A directory
already gone counts as clean, since removal reads absence as success. The read passes
`--ignore-submodules=none` and sets `core.trustctime`, `core.checkStat` and `core.fileMode` back to
git's defaults (every host git call already runs with `core.fsmonitor=false`), so a repository's
config cannot hide a same-size rewrite that kept its mtime or a changed executable bit, and a tree
whose index marks any file assume-unchanged (one `update-index --assume-unchanged`, or a
repository's `core.ignoreStat`, which marks every file a checkout writes) or skip-worktree (a sparse
checkout among them), in its own index or in a checked-out submodule's, counts as unreadable, since
status never sees an edit to such a file. `13-pr-wait`'s finalize, which has no such choice, keeps a
dirty or unreadable worktree and still finishes the task, and the completion of a custom type
without step 12 reaps its worktree only while clean. Ignored files are not counted. `run_app`'s
Finish and Cancel still remove the worktree: Cancel is the discard action, and `run_app` has no step
that could ask.
