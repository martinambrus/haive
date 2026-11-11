# Workflow commits

Before `git add -A`, both gate 3 and the DAG issue committer run `assertDependencyCommitSafe`.
It checks uncapped untracked paths and tracked changes against the task's fork point, including
earlier issue commits, deletions and both sides of renames. Modified infrastructure and
third-party source refuse the commit. Restoring upstream source to its baseline is allowed.
Ownership comes from the baseline policy described in [Review scope](review-scope.md), never
a declaration introduced by the agent. Package manifests, lockfiles, patch files and project
integration code remain valid commit artifacts. `.patch` and `.diff` artifacts under the
project's `patches/` directory may mirror upstream package names; files inside installed
packages remain upstream even when they themselves are patches. This guard checks Git deliverables; ignored
installed source and ad-hoc scripts are constrained by the agent rules and review, rather than
being inspected by this path check.
Baseline and working Composer manifests are parsed independently, so a repaired manifest can
establish protection even when the committed copy is malformed; valid baseline evidence still
protects infrastructure when the current copy is broken or removes the framework declaration.

`10-gate-3-commit` generates its message with a pre-form LLM invocation. Detection remains
deterministic: the worker builds the commit-diff snapshot from the same staged, unstaged and
untracked files `git add -A` will include. The message invocation receives bounded before/after
excerpts from that snapshot, with unchanged edges stripped so edits near the end of large files
remain visible. Binary files, oversized content and files that could not be read carry metadata
only; truncation is explicit. A symlink or a submodule carries its target text with a `link` mark,
so a file turned into a link does not read as a content change.
The snapshot is against HEAD, because this message describes the pending commit rather than
the whole task's changes already committed by DAG execution or prior fix rounds.

An untracked nested repository without a checked-out commit is listed separately at gate 3.
The form explains that it can be committed inside, removed, or left out; the outer commit
stages the remaining changes and excludes that checkout. Apply rechecks its HEAD when the
form is submitted, since it may have gained a commit while the gate was waiting. This proof
precedes the dependency guard: only those exact untracked checkout boundaries are omitted
from its proposed deliverables, with tracked changes against the fork point still checked
in full.

A nested repository with a commit is refused at gate 3 when the add would put a gitlink in the
commit that HEAD does not hold and the commit's `.gitmodules` has no entry with that path and a
non-empty url (`_gitlink-registration.ts`, right after `assertDependencyCommitSafe` and before
`git add -A`). What the add would stage is worked out on a scratch index (`GIT_INDEX_FILE` in the
temp dir, filled from the real index with its assume-unchanged and skip-worktree flags, same argv
as the real add through `stageAllArgs`), so the real index is never written. `core.splitIndex=false` is set there because a split index writes
`.git/sharedindex.*` into the repository. The check reads modes and exit codes only. It runs when
the real index already holds a new gitlink, or the status lists an untracked directory (`?? dir/`),
a work-tree type change (` T path`) or an intent-to-add entry (` A path`), the three shapes a
repository can arrive in unstaged. A git failure refuses. It can leave unreachable blobs in
`.git/objects` after a refusal: the same content gets the same id, so a retry adds none and gc
prunes them. At gate 3 unborn repositories stay excluded, and a gitlink HEAD already holds is left alone.
The thrown text names each path and the two ways out, register it as a submodule or include its
files as ordinary files. Detect carries an optional `unregisteredGitlinks`, optional because the
payload is persisted and best effort since apply still decides, and the form lists it.

The DAG issue committer (`commitIssueWork`, `dag-executor.ts`) runs the same check on the issue
worktree, after `assertDependencyCommitSafe` and before its `git add -A`, with no exclusions, so
an unborn nested repository makes the scratch add fail and the step fail loudly, nothing
committed. The refusal is `unregisteredGitlinksMessage(paths, { key, worktree })`: the issue key,
each path JSON-quoted, the worktree as the task terminal sees it, and the two ways out. Way 1 is a
`.gitmodules` entry written into that worktree; the text gives no `git submodule add`, since git
does not run there. Step 06c fails, the issue stays accepted with `merge_status` null, and
`resetDagCurrentLevelForRetry` leaves it alone, so Retry commits it after the fix with no coder
dispatch and siblings already merged stay merged. A git failure inside the check fails the step
naming the issue, never skips the check.

A `.git` inside a tracked directory is a different shape: status lists its files one by one
(`D dir/a`, `?? dir/inner.txt`), so no gitlink would appear and the add would flatten them, the
repository's history lost with the worktree. Gate 3, the DAG issue commit and Run app Finish refuse
it (`FlattenedRepositoryError`), scanning untracked entries only and reading no `.git` contents, so
a stray `.git` is refused too and the text does not claim each one is a repository. Run app Finish
also refuses the unregistered gitlink, with gate 3's text.

The first commit of a repository that had no git (`01-worktree-setup`, `12-post-onboarding`,
`03-upgrade-commit`) warns and continues (`initialGitlinkWarnings`), never refuses: a refusal would
stop onboarding of any uploaded tree holding a nested clone. Each path is stored as a step warning,
since the web does not render a step output's `warnings`. A failed check logs and continues. A first
commit that exits nonzero with HEAD moved is recorded as landed in `01-worktree-setup`, the one site
where it happens: 12 and 03 fail earlier, on the staged-name read.

When the DAG commit's `git add -A` stages nothing though the status listed entries, the changes are
inside a nested repository the branch already holds. The step commits nothing and stores a warning
per path. Whether anything is staged comes from the exit code of `diff --cached --quiet`.

The invocation asks for a JSON `commitMessage` containing a subject and optional body and
instructs the agent to answer from the supplied changes without using tools. `disableTools`
is a best-effort optimization: adapters that support it disable built-in tools; the others
keep them available and remain eligible. The gate never switches away from the selected CLI
because it cannot disable tools. `toolProfile:'none'` still wires no MCP servers, including
on Muse where disabled built-in tools and deferred MCP tools can cause a provider error.
Git remains host-side. Change evidence is fenced at prompt-build
time. The selected provider's operator rules remain injected, including commit conventions;
the step's explicit JSON contract takes precedence where necessary. Evidence fencing covers
older persisted detect payloads that only have the diff summary. Repository
secret-mask policy removes denied file contents from the message context; it conservatively
omits tracked secret contents too and applies even with masking switched off. Git may not pair
a moved file (`status.renames=false`, content rewritten below the similarity threshold, or a move
over a tracked file), so a denied file moved to an allowed name arrives as a deletion plus an
addition or a modification, a moved file's old path can be recreated in place, and a protected file
staged then moved reads as `AD` plus an untracked copy: when any denied path appears in the change,
under any status, or the change list is capped and may not show every change, no file but a
deletion shows its content, only its path. A failed policy lookup leaves only the diff summary
available, never the unfiltered contents.

The LLM runs before the gate parks and its suggestion becomes the editable form default. The
web changes viewer stays hidden until the form schema is ready, so the terminal can mount
above it without shifting an already visible diff. Completed and skipped gates keep their
diff available, including older records without a persisted form schema. Generation skips
clean workspaces and non-git directories and is optional, with one re-roll for
unusable output: without a usable suggestion the form offers manual entry, never the old static
`feat: apply workflow changes` fallback. Apply uses the submitted message, or the generated
suggestion when the field is absent, and rejects an explicitly blank message before staging.
The optional fallback also applies when the worker supplies an empty or entirely disabled
provider list and dispatch returns no invocation; required LLM steps still fail in that case.
The user can still skip committing. Step-runner retains the invocation through form submission
and recovery using its existing pre-form lifecycle.

The gate tests cover real git changes, message overrides, output validation, containment and
secret omissions. `step-runner-llm.test.ts` exercises the actual gate definition through
`waiting_cli` to `waiting_form` and submission. `workflow-commit-smoke.ts` fabricates its change
before gate 3 detection and verifies that the bypass LLM message prefills the form.

Whether there is anything to commit is decided by structure, never by git's wording (a localized or reworded git used to turn an empty commit into a failure). Gate 3, the knowledge-base commit, skill sync and Run app all commit through `gitCommitStaged` (worker `repo/git-commit.ts`): `git diff --cached --quiet --ignore-submodules=none` exits 0 for nothing staged and 1 for changes, and anything else is a failed read that throws rather than reading as "nothing". The submodule flag matches `git commit`'s own check, which commits a staged gitlink move even under `submodule.<name>.ignore=all`. Gate 3 and Run app commit the whole index; with nothing staged they still commit while `MERGE_HEAD` exists (read by `rev-parse -q --verify`, 0 or 1, anything else throws), since `git commit` concludes an open merge. The knowledge-base and skill-sync callers supply the paths they staged: both the staged read and `git commit --only -- <paths>` are scoped to those paths, leaving unrelated staged work intact. The scoped callers retain missing owned roots when Git still tracks their contents or has their deletion staged: `gitStageScopedPaths` stages roots still in the index and includes already-staged whole-root deletions only in the commit scope, since `git add` rejects those missing paths. Never-tracked missing roots are omitted, and failed index or staged reads throw. A scoped commit refuses an empty path list or an open merge, which only a whole-index commit can conclude.

After its commit lands, gate 3 reads the new HEAD sha and the changed files. A read git gave no answer for (`gitGaveNoAnswer`) is retried once; if it still has none, `tasks.commit_sha` keeps whatever an earlier round stored (NULL on a first round) and a step warning names the read; a plain non-zero exit still writes NULL. A NULL sha means `haiveOwnShas` cannot recognise that commit as Haive's own later.

Run app's Finish commits only what the form showed. The form pins the reviewed paths, their parent
commit and the tree built from them (`commitPreview`; Haive's projections and atomic-write temp files
are left out), and Finish commits that pinned tree with a compare-and-swap on the parent
(`commitGitPreview`, `repo/git-preview.ts`): an edit made in the terminal after the preview, or
other staged work, is neither swept into the commit nor lost. If the reviewed bytes or the branch
changed before Finish, the form comes back refreshed with a warning note asking to review the new
preview (older parked forms too, since the note is added outside their frozen schema); only the
parent mismatch reads as "branch changed", any other ref-update failure is an error. When the
preview cannot be built in full (a diff read failed, or more than 500 changed files) Commit is
hidden and the form says why: an oversized session is committed from the terminal, and Finish still
works without committing. Its commit refuses while a merge is open in the checkout ("Finish or abort
the open merge before committing session edits."). A Retry after a later failure (a failed
put-back or push) recognises the commit it already made by structure, not by message: HEAD whose
parent is the preview's parent and whose tree is the pinned tree, or the exact put-back commit
recorded on top of it. It then skips the commit and goes straight to put-back and push, keeping
`committed: true` and the original commit. A foreign commit, a branch change or an edit to a reviewed
path still reopens the form. Its gitlink check judges the pinned tree, not the live index: the
scratch index is filled from `preview.tree`, only gitlinks it adds or changes against the preview's
parent are judged, and `.gitmodules` is read from that same tree, so a registration staged after the
preview does not count. Before the ref compare-and-swap, before the index reset, and on that Retry
before put-back and before push, `symbolic-ref -q HEAD` (exit code only) must still name the
previewed branch, or still be detached for a detached preview. A switch found before the write
refuses with "branch changed"; one found after the ref moved skips the reset and names the branch
the commit landed on (at the push seam that text is the push's failure note). Git has no atomic
HEAD-and-ref check, so one process spawn between the second check and the index-only reset of the
reviewed paths stays open; at worst a reviewed path shows as unstaged on the new branch.

Run app's Finish form treats Commit and Push as independent choices. A push with Commit unticked
publishes the branch's existing commits without staging or committing session edits; the ordinary
projection put-back still precedes the push and leaves unrelated staged and unstaged work alone.
The push keeps its existing best-effort failure note. Learning capture carries gate 3's structural
`committed` outcome separately from its SHA: a landed commit whose SHA could not be read is described
as recorded with its SHA unavailable, both in the prompt and in the deterministic fallback learning.
An explicit no-commit outcome retains the no-commit wording. An older detection payload with neither
a SHA nor a recorded outcome says that its outcome was not recorded, rather than inferring it from
message text.
