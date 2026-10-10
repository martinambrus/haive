# Merge conflicts

The DAG's level merge and the merge resolver (`12-worktree-cleanup`, `00a-sync-base`,
`13-onboarding-push`) share the git core in `git-merge.ts`. Each fix agent edits the conflicted
files, and the host verifies, stages and commits, so a fixer must never start from what an earlier one
left. Five rules keep it that way, each MEASURED on git 2.43 and 2.54:

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
  are handed back to the merge dir's owner; a directory that already stood keeps its own. `.haive/`,
  `.haive-data/` (other writers keep them) and gitlinks are never moved; a link or a name that is
  not UTF-8 stays and is reported, a link with its target in the manifest, since a scratch worktree
  removed later takes the link with it. A name is judged by its bytes, since a valid one can hold
  U+FFFD, the character an undecodable byte reads as. A directory a fixer made where a file stood
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
  row and the next conversation resumes a merge a cancelled one left open. Nothing but its fixers
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
  rest of the task's work, a same-branch root is left as the fixer left it, merge still open, and a
  plan merge's scratch worktree waits for the next pass or a Save or Pull, as above.

The resolver checks for a committed merge before its budget halt, so a merge finished by hand after
a halt finishes the step on a Retry.
