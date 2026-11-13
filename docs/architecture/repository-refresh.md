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
HEAD. It also refuses, with `Not refreshed: could not read the remote (...)` or `...the checkout's HEAD could not be read (...)`, when git cannot answer a read the refresh needs: only exit 2 of `git remote get-url origin` says "has no remote", and a reason is returned rather than thrown because a throw sets the repository to `error` (`queues/repo-queue.ts`), which hides its Terminal, Create task and Plan. Git itself refuses a fast-forward that would overwrite a local change, but not Haive's own pending projection files: those are set aside before the fast-forward and re-rendered over the new head (`setAsideHaiveProjections`, see [Onboarding template versioning](onboarding-upgrades.md)), and one that is not what Haive last wrote refuses the refresh naming the file. What the fast-forward wrote, run as root over a tree the sandbox user owns, goes to that user as a merge's does (`handBackAfterMove`, see [Merge conflicts](merge-conflicts.md)). The task check is read
twice: once under the claim, and again with the fast-forward itself under the project-state lock
(`lockProjectState`), and the set-aside reads it a third time under each of its own locks before it touches a file (its
restoring transaction takes the task-creation lock, `lockRepositoryTasksKey`, first; its first takes
only the domain lock), so a task that starts while the refresh fetches or waits for that lock, and an
upgrade still writing its record (which holds the same lock), keeps the checkout where it was. A same-branch merge reads the same check before it opens a merge in the checkout ([Merge conflicts](merge-conflicts.md)). A task
that starts after the fast-forward is not fenced out, since nothing that starts a task reads the claim:
the window writer 1 in [Onboarding reset](onboarding-reset.md) leaves open for the reset. It loses nothing
here either, since the fetch writes no working tree, the fast-forward stops at a change git sees and
the rebuild renames; what it can cost is a git lock collision that fails one side, which a Retry
clears. Before the checkout moves, a plan row stamped before migration 0196 takes its plan base from the plan.json still on disk (`seedPlanBaseFromCheckout`); a seed that fails fails the refresh and leaves a usable checkout where it was, since afterwards no Pull could recover that base. A rebuild needs proof that the checkout is unusable at its own top level. Exit 1 of the quiet HEAD
probe is not proof alone, since a broken branch ref exits 1 too: `provesUnbornHead` needs HEAD to name a branch and a clean, empty enumeration of it; a failed top-level probe needs strict no-follow structural reads proving
missing or invalid metadata before it can justify a rebuild. A corrupt config, unreadable metadata,
external git dir or a command that gave no answer is unknown. That path ends in `error`, moves
nothing and does not import mirrors from an unchecked tree. When git returned an error status, the
message says repair is needed before Retry can help; git stderr goes to the diagnostic log. The
structural proofs and exit-code distinctions were checked with git 2.43.0 and 2.54.0.

Before moving an unusable checkout, a folder source must itself pass the same usable-checkout proof,
and a remote must pass the clone URL rule. A missing, unborn, unusable or unreadable folder source
ends in `error` with nothing moved. Whatever stood at the destination is then renamed to a
`<repoId>.aside-<time>` sibling, never removed; strict stat failures stop before that move. Folder
copies, and remote clones requested by a recovery, build in a fresh `<repoId>.rebuild-<uuid>`
sibling and publish with `renameNoFollow` and `noReplace` only after the build and its verification
complete. A failure before the data restore (below) removes only that attempt's staging entry;
failed cleanup names both retained siblings. Once the restore has started, a failure keeps the
private replacement and its journal images. Ordinary remote rebuilds still build directly at the
destination (the separate incomplete-clone recovery finding remains queued in T486).

The rebuilt tree must pass `usableCheckout` before detection is persisted. A build or verification
failure after the move is final for that BullMQ job (`UnrecoverableError`), names the aside by its
basename so path scrubbing cannot hide it, and requires a manual Retry. This prevents automatic
retries from moving another partial tree aside and replacing the pointer to the original. Undo by
renaming the kept aside back once the destination is free; the aside is the old tree, not a backup
of later work. A process death can still leave an unnamed aside or staging sibling, and a later
Retry can clear the only notice; T486 tracks retention and durable reporting. A failure of the final
`persistDetection` write remains retryable. Neither rebuild nor Retry deletes the preserved tree. A read-only folder
import is re-scanned as before, and a repository with no remote and no folder answers 409 without
touching its row.

**A checkout git cannot read gets a repair code and an explicit rebuild.** When the refresh
cannot prove the checkout usable or unusable (the unknown path above) the row is `error` with
`repositories.error_code = 'checkout_repair_needed'` (migration 0225; `'source_repair_needed'` when
the folder source could not be examined and needs repair; the codes are `REPOSITORY_ERROR_CODES`, `@haive/shared`), and the
page keys its actions on the code, never on the message: "Check repair" re-runs the refresh as
check only (`checkCheckoutOnly`, set by the api for a repository holding either repair code and
enforced by the worker), and "Rebuild checkout" (when the source can rebuild) posts the recovery, the
user's explicit consent to move the checkout aside although it could not be proved unusable. A check
only refresh never rebuilds and, whatever fails, keeps the repair code it was admitted with: a
checkout still unusable says so, a read that never finished stays a retryable failure, and only the
recovery rebuilds, keeping this install's data. The
code clears when an ordinary preparation starts or detection succeeds; a recovery keeps it until then, so a refresh sent while the recovery is queued or running stays check only, and a preparation stranded by a stop keeps it too. A recovery job first re-checks the checkout: one that is
usable again (held by a task or not) finishes as an ordinary refresh, moves nothing and clears the
code. Otherwise it takes the ordinary rebuild path (seed, source proof, move aside, build, verify),
keeps every repository record and this install's settings, KB and plan data. Before the move it
handles a pending project-state write intent under the task key and then the project-state lock.
An intent naming an abandoned private replacement (a stopped earlier restore), or one left with no
checkout at all, is cleared; no tree or journal image is deleted. An older unmarked intent with a
recorded journal stage is classified by whether that stage is present under the current checkout.
A current-checkout intent, and an unmarked one with no stage, still settles against the current
checkout or refuses with the cause and moves nothing. The move transaction re-checks that no
intent appeared. The private
replacement drops the legacy mirrors and is restored through the ordinary writers without a commit:
the state record is written from the database with its base and watermark, and the plan is
rendered from the database with `synced_hash` stamped and the agreed `synced_snapshot` left as it
was, so a later remote plan still merges three-way. When this install holds no plan rows the
incoming `plan.json`/`plan.md` stay for the ordinary first import, and when its render context is
null the incoming state files stay for the ordinary sync, so a later Save cannot delete the team's
files. A restore that reports `superseded` is retried up to three times; any other outcome fails the
recovery. Any rebuild, recovery or not, is refused with a sentence naming the count while a task of the
repository that is neither completed nor cancelled has a worktree under the checkout (its audit column, else the latest `01-worktree-setup` output for a legacy task; a `failed`
or `created` one included, since its unpushed commits would move with the tree): the api refuses at
admission (409), and the worker counts again, together with the holding tasks, under the
task-creation lock (`lockRepositoryTasksKey`) in the transaction that renames the checkout aside;
the lock spans only the recount and the rename, never the clone. Cancel the task, or finish it, and
rebuild. A start after the rename can still overlap the clone (the window above).

The list's `canRetry` / `retryUnavailableReason` describe the durable source the retry
route can use: a local folder, a remote URL, or a completed upload record belonging to the
repository's owner whose archive has not been recorded as unavailable. A blank project or a
clone without a remote cannot be refreshed; the card replaces stale Retry copy with instructions
to delete and create the repository again from a URL or folder. Root claims, holding tasks and
live queue jobs remain temporary route refusals and do not hide Retry. An older list response
without capability fields keeps the Retry action for compatibility. Repository archives use
the chunked API: `POST /repos/upload/init`, `PUT /repos/upload/:id/chunk` with `Content-Range: bytes start-end/total`,
then `POST /repos/upload/:id/complete`. Completion persists its `repo_uploads` source before
enqueuing extraction, so a failed preparation can use Retry. The unused single-shot
`POST /repos/upload` route is retired (404). Existing completed upload records remain valid
Retry sources, and archive retention is unchanged.

## Remote relink reconciliation

`POST /repos/:id/remote` commits a credential-free UUID in
`repositories.remote_relink_intent` before the relink transaction or its first Git
mutation. Recording intent uses a separate fresh database client and a short
transaction with a bounded repository row lock. It stores no URL or credential.
A failed intent write answers 409 before changing Git; a busy lock retains the
ordinary busy refusal. The relink transaction then locks the row, verifies that
its token is still current, inserts the required audit, changes Git and updates
the repository columns. A token already settled by the sweep, or superseded by
another request, refuses before any Git mutation.

The intent lives in the database, outside the sandbox trust boundary. Nothing in
the repository tree can trigger a reconcile: the old
`.haive/remote-relink-pending` file is neither read nor written, and a planted
file, link or directory there is inert. No repository-controlled file grants the
root API permission to remove or rewrite origin. Paths remain rooted at the
storage/local repository anchor, and Git uses the hardened relink runner.

Each request replaces the token under its intent transaction's row lock and
remembers whether it inherited an unresolved predecessor repair. Such a request
never clears that repair on a clean refusal or successful in-lock undo: the
sweep must still settle the predecessor's outcome. Every clear compares both
repository ID and this request's token (`WHERE id = ... AND remote_relink_intent
= ...`), so it cannot erase a newer request's intent. Known outcomes are cleared
in their own committed transaction after the relink transaction has rolled back,
rather than clearing a column inside a transaction that is about to roll back.
A failed clear fails the request; a clear that did not commit leaves repair pending.

A connection-class failure is reconciled only after this request successfully
recorded intent. Reconciliation uses a fresh database client, rechecks ownership
and non-null intent under the repository row lock, and aligns origin with the
committed row, clearing push overrides when replacing an existing origin. It
clears the locked token in that same transaction. Fresh clients end with
`end({ timeout: 5 })`. If the fresh read or Git repair fails, intent remains
for another attempt and the request returns 500 explaining the uncertain outcome.
A failure before this request records intent leaves Git alone, including a
folder import's Git-only origin whose database `remote_url` is null.

A successful relink leaves intent for locked reconciliation. For a request with
no predecessor repair, a known refusal before any mutation clears its token,
as does a successful undo under the relink row lock. An unreadable previous-remote
snapshot also clears its token even without an exit status: that read changed
nothing. The add-origin and clear-push-URL mutation sites still retain intent when
the outcome is unknown (deadline, signal or spawn failure). A failed undo also
retains intent. A restore after a non-connection COMMIT failure runs after the
lock has been released and never clears intent, even if the undo succeeds.
That late Git restore can still race a concurrent relink; retained intent lets
the sweep align Git again.

The API starts one bounded sweep after its HTTP server is created and stops its
timer when the server closes. It selects only repositories with non-null
database intent, at most 25 IDs per 30-second tick, rotating the cursor and
scheduling only after the preceding pass finishes; its timers are unref'd. The
request pool is used only to collect the page, never held across sweep Git.
Each selected repository is rechecked under the fresh-client lock, taken with
`SKIP LOCKED`: a repository a relink holds is passed over, not waited for, so the
sweep never acts on a live request's intent the moment that request rolls back;
the next tick sees it again. A repository without intent runs no Git. Repair
errors warn and retry on a later rotation. The route's own reconcile after a
connection loss still waits for the lock. `GET /repos/:id` remains passive: it
reads database columns without reconciliation, Git work or database writes, and
no repository response returns the intent token. Process-death recovery happens
through the sweep or the next successful relink.

Limitations: pending intent makes a null committed remote authoritative as
"no origin". After intent is committed on a folder import, connection loss,
process death, failed undo, an unknown-outcome timeout or signal, or a
non-connection COMMIT failure with a successful undo can therefore remove a
pre-existing Git-only origin. This also applies when a clean refusal inherits
a predecessor's unresolved repair. Two short windows remain where a sweep tick
can act on a live request's intent on a folder import: between the request's
rollback and its own intent clear on a fresh connection (a few round trips, or
indefinitely if that clear fails), and between recording the intent and taking
the relink lock (the request then answers 409 and a retry restores the origin).
No durable pre-change origin snapshot is kept;
preserving one across process death requires a separately designed snapshot
with credential-handling rules. Each Git call has a 10-second deadline and a
2-second kill grace, but there is no aggregate deadline over all calls under the
row lock, and an uninterruptible kernel I/O wait cannot be made to exit by SIGKILL.
The killed-after-config-rename boundary still needs live evidence; retained
intent is the recovery mechanism for unknown Git outcomes.

Migration 0235 adds the nullable UUID column last in the Drizzle table. Roll back
by reverting the code and keeping the column; never drop it. Existing database
tokens and old repository marker files are inert without the reconciliation code.
The real Git/PostgreSQL probes cover a lost COMMIT reply, API death before COMMIT
on both a first link and an existing managed remote, locked-config refusals that
preserve origin and push URLs after a sweep, and planted files without database
intent that leave origin unchanged. Unit controls cover token comparison,
predecessor repair retention, intent ordering and lifetime, unanswered reads,
bounded sweep rotation and API start/stop wiring. The Git signal controls wait
for a FIFO reader with a nonblocking writer open, keep that writer until cleanup,
and close it in `finally`; they do not read kernel wait-channel names.
