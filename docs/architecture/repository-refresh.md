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
upgrade still writing its record (which holds the same lock), keeps the checkout where it was. A same-branch merge reads the same check before it opens a merge in the checkout ([Merge conflicts](merge-conflicts.md)). Task starts and revivals now read the live root claim under the task-creation key and answer
409 while it is held, including after the rename transaction releases that key and throughout the
clone and restore. Explicit recovery claims as `rebuild` and says "This repository is being rebuilt
from its source. Wait for that to finish and try again." An ordinary refresh can also rebuild, so
its `refresh` claim refuses Start and revival too, saying "This repository is being refreshed from
its source. Try again in a moment." This deliberately extends the creation rule to a deferred
Start and failed or dead task revival; a refused Start stays `created`, and a refused revival keeps its failed
or dead state. Step Retry, Skip and rerun on a live task retain their existing admission. No database connection is held across the build. Before the checkout moves, a plan row stamped before migration 0196 takes its plan base from the plan.json still on disk (`seedPlanBaseFromCheckout`); a seed that fails fails the refresh and leaves a usable checkout where it was, since afterwards no Pull could recover that base. A rebuild needs proof that the checkout is unusable at its own top level. Exit 1 of the quiet HEAD
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
code clears when an ordinary preparation starts or detection succeeds; a recovery keeps it until then, so a second refresh sent while the recovery is queued or running answers 409, and a preparation stranded by a stop keeps it too. A recovery job first re-checks the checkout: one that is
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
rebuild. A cancelled task with a worktree keeps that hold only while a `task.cancelled` event falls inside the seven-day
re-drive window (`CANCEL_REDRIVE_LOOKBACK_MS`, shared with the worker and matching migration 0186),
unless `task.cancel_finished` proves its asynchronous teardown ended (or was explicitly abandoned).
Legacy cancels without an event and expired cancels cannot hold a rebuild forever; a recent Cancel alone is insufficient. The
refusal asks the user to wait for cancellation cleanup before rebuilding. The claim blocks a
Start or revival after the rename too (the admission rule above).

The list's `canRetry` / `retryUnavailableReason` describe the durable source the retry
route can use: a local folder, a remote URL, or a completed upload record belonging to the
repository's owner whose archive has not been recorded as unavailable. A blank project or a
clone without a remote cannot be refreshed; the card replaces stale Retry copy with instructions
to delete and create the repository again from a URL or folder. An ordinary refresh of a `ready` repository keeps it `ready` while queued or running, leaving
its Terminal, Plan and task links available. If the worker proves that checkout unusable and
escalates to a rebuild, it commits `cloning` before the rename transaction moves the old checkout
aside, so archive downloads, new Terminal connections and repository Editor starts refuse the
unfinished checkout. Detection restores `ready` after verification. A genuine preparation or
recovery also uses `cloning`. `refresh_pending` and its owning `refresh_job_id` (0250, declared last) cover **every**
repository preparation: initial create/clone/copy/init, completed upload extraction, read-only
scan, refresh and recovery. Each admission chooses a UUID before its transaction, stores it
with the pending marker, and enqueues that exact BullMQ `jobId`. Availability and owed work
are separate: detection may publish `ready`, while the marker remains through all mirror,
project-state, RTK and plan imports, so maintenance and the updater still count the job.
A second admission refuses while it is set.

The repo queue installs an invocation-local ownership scope (`repo/job-owner.ts`) from the
repository ID and BullMQ job ID. Its predicate requires both that ID and a pending marker;
null is never authority. Pickup refuses an obsolete, completed or ownerless job before calling
a handler. Refusals warn with a structural reason (`no_owner_on_row`, `different_owner`,
`not_pending`, `invalid_scope` or `ownership_changed`), never a reason inferred from message copy.
Every root-writing handler rechecks after acquiring its renewing root claim,
before its first filesystem mutation. Detection rechecks before reading and qualifies its
ready/detection/storage UPDATE, skipping imports when that UPDATE no longer owns a row.
Cloning escalation and the queue's late error UPDATE use the same predicate. Success and
final failure clear both marker columns only for their owner; retryable failure keeps them
through backoff. A same-owner redelivery of an initial-only copy, init, clone or extract job
whose structural status is already `ready` resumes the mirror imports and marker clear without
repeating detection or replacing the checkout. Its detection result and caveat copy remain intact.
Completion-marker cleanup runs outside the handler-error catch: if that write alone fails,
the ready result stays ready and the same-owner retry resumes imports and cleanup. It must
never write `error` for a cleanup-only failure, since that would send an initial-only retry
back through checkout replacement and delete edits made during backoff. If cleanup exhausts
its retries, the ready row keeps its pending marker until the stranded-preparation sweep
releases it under the existing queue/claim/age checks.
Enqueue failure cleanup also compares the admission ID, so a lost/late
acknowledgement cannot overwrite a completed job or a newer admission.

**Legacy jobs are refused, never adopted.** Before deploying API and worker together, drain old
preparations, including delayed retries. Run both read-only checks below against the deployment's
Postgres and Redis. Every result must be zero before recreating either service:

```sql
SELECT id, status, refresh_pending, refresh_job_id, root_claimed_at
FROM repositories
WHERE status = 'cloning'
   OR refresh_pending
   OR root_claimed_at > now() - interval '15 minutes';
```

The query must return zero rows. The updater's database count alone misses legacy delayed initial
retries (their rows can already be `error`) and legacy post-ready imports (`ready`, without a
pending marker). Only the BullMQ repo queue sees those jobs. Confirm the queue name and prefix
with `redis-cli --scan --pattern 'bull:haive-repo:*'` (never `KEYS`); `haive-repo` and `bull` are
the defaults. With the deployment's connection options, check all these read-only commands:

```sh
redis-cli LLEN bull:haive-repo:wait
redis-cli LLEN bull:haive-repo:active
redis-cli LLEN bull:haive-repo:paused
redis-cli ZCARD bull:haive-repo:delayed
redis-cli ZCARD bull:haive-repo:prioritized
redis-cli ZCARD bull:haive-repo:waiting-children
redis-cli SCARD bull:haive-repo:stalled
```

All seven counts must be zero; completed and failed sets do not block this drain. If any check
is non-zero, wait for the work to finish and repeat both checks. `ZRANGE bull:haive-repo:delayed 0 -1`
and `LRANGE bull:haive-repo:active 0 -1` inspect job IDs read-only: legacy jobs have numeric IDs;
owned jobs have UUIDs matching `repositories.refresh_job_id`. Keep maintenance admission closed
through the checks and deployment so new work cannot enter after the drain. Deploy both with
`pnpm docker restart api worker`; an old API paired with the new worker creates ownerless jobs
that the worker refuses.

If an ownerless legacy payload is nevertheless
redelivered, it completes as a logged no-op, without detection, imports or checkout writes.
An ownerless `cloning` row remains recoverable: once no live queue job/claim remains and the
five-minute age guard expires, the existing stranded-preparation sweep changes that row to
`error`. It runs at worker boot and every 60 seconds; no worker restart is needed. Recovery
usually takes at most about six minutes, or about sixteen minutes behind a stale root claim.
Retry then admits a new owned job where a durable source exists; an initial blank project
without a source needs delete-and-create. A legacy ready row stays ready. Never backfill an
owner from an arbitrary payload or grant a null owner permission to rebuild.

The ordinary stranded-preparation sweep also
releases an old marker whose queue has no live job, preserving any repair code. A `ready` row
without a repair code keeps its status and display copy: the sweep clears only the stale marker
and logs that release once. The maintenance blocking list labels every marked job `pending preparation`, including initial
preparation and its post-ready imports. Root claims, holding tasks and
live queue jobs remain temporary route refusals and do not hide Retry. An older list response
without capability fields keeps the Retry action for compatibility. Repository archives use
the chunked API: `POST /repos/upload/init`, `PUT /repos/upload/:id/chunk` with `Content-Range: bytes start-end/total`,
then `POST /repos/upload/:id/complete`. Completion persists its `repo_uploads` source before
enqueuing extraction, so a failed preparation can use Retry. The unused single-shot
`POST /repos/upload` route is retired (404). Existing completed upload records remain valid
Retry sources, and archive retention is unchanged.

T780 PR1 rollback: drain **all** preparation work, including initial post-ready imports and
delayed retries, before rolling API and worker back together. Leave migration 0250 and its
columns applied; this change adds no migration. A rollback restores the older ownership gaps.
Do not alter `.aside-*` or `.rebuild-*` siblings as part of this rollback.

T594 rollback: revert the code commits after active rebuilds and cancellation teardowns settle.
Keep additive migration 0250 and both columns on rollback; never remove an applied file.
Settle every pending refresh before downgrading the API/worker/updater. Deploy all three together:
an older updater cannot count a new API's ready refresh. The new updater detects the marker's
presence before counting so it can drain a source schema that predates 0250. Keep existing `.aside-*` and `.rebuild-*` siblings;
reverting code never restores or removes them. The recovery staging and repair-code retention
already shipped in `2c16ca95e` remain unchanged. T594 C2 also resolves T602 item 2; refusing a second refresh resolves T602 item 5.

## Checkout access during replacement (T780 PR2, reduced scope)

`@haive/shared/checkout-access` is the server-side admission policy. `read` requires ready;
`mutation` admission requires ready, no owed preparation (`refresh_pending`) and no foreign live
root claim. Explicit `repair` availability also permits an error checkout for raw attachment
reads, attachment removal and remote configuration repair. Neither admits cloning.
`preparation` requires the actual renewing `RootClaimHandle`, verified against its private runtime
registration, repository ID, preparation kind (`rebuild` or `refresh`) and the live row's owner.
A boolean, copied object, another repository's handle, expired/replaced claim or released handle grants no permission. This mode is available for
preparation's private restore; wiring existing preparation/projection callers remains follow-up work.

`withCheckoutMutation` acquires a distinct `mutation` root claim **before** attachment/domain/row locks,
checks availability again after acquisition and releases in `finally`. It retains no connection
across an upload body or subprocess. A claim collision answers 409 `checkout_unavailable`;
concurrent independent mutations in the same repository must retry, with copy naming the held
kind. A preparation queued after an admitted mutation waits: `withRootClaim` raises
`RootClaimBusyError`, and the queue delays pickup five seconds without changing status, clearing
its owner or consuming a failure attempt. The admitted mutation can finish while that preparation
is owed; a new mutation cannot enter that queue gap. Before every physical step, independent
writes check the registered handle's last confirmed lease stamp as well as `owner.lost()`,
refusing at `ROOT_CLAIM_STALE_MS - CHECKOUT_MUTATION_SAFETY_MS` (30 seconds before takeover)
even when renewal cannot prove a takeover. Neither failed attempts nor delayed reply arrival
refresh that stamp. This write fence has an injectable clock and does not stop lease renewal.
Claim loss is logged on release. A refused post-stream recheck takes back
the upload by its pinned inode, leaving no orphan in the public tree and preserving an aside.
A read uses admission only:
a failed acquisition rechecks availability to classify a rename as `checkout_unavailable`, while
an already verified descriptor can finish on the preserved inode. These are not snapshot exports.
The policy never creates an anchor or changes repository status or preparation ownership.

This PR applies that policy to attachment upload/raw/single-delete/folder-delete, remote relink
and its reconciliation sweep (one info line per checkout hold, redriven after release), and
whole-plan deletion (the lease spans its database deletion and both physical mirror removals). Attachment lists and database-only plan list/detail/node edits
remain available. A task whose repository was deleted can remove its attachment rows DB-only,
without guessing a filesystem root. The raw route's error recheck preserves ordinary missing-file
and containment errors when the checkout is still ready. Ordinary ready fast-forwards do not hide read-only access.

The remaining independent entries in the T780 analysis are **not yet covered**: plan writer/importer
and Save/Pull, project-state sync/writer/journal/rules/metadata recovery, initial detection/legacy
imports, task file/archive/root resolvers, scope/code previews, onboarding/upgrade/data/snapshot
status, runtime ensure and DDEV control. They still need the same policy at their admission/locked
boundaries, with task-key → domain → repository-row order and dirty/outbox obligations retained
on holds. Interactive mount suspension is PR3. Do not infer complete checkout exclusion from the
new attachment/remote/deletion coverage.

Rollback: settle active attachment, remote and plan-delete operations and all preparations, then
revert the API/shared/database code together and rebuild shared/database from that revision. There
is no schema migration. Preserve relink intents, dirty/outbox rows and every aside/staging sibling.
Rollback reopens the covered races; it never moves an aside back automatically.

## Remote relink reconciliation

Relink and reconciliation hold the checkout mutation lease before their existing intent/row
locks. Repair on an error checkout stays available; cloning and a foreign claim hold work without
consuming the relink intent. The route uses a dedicated fresh client for its Git transaction,
keeping the request pool free. Both reconciliation and attachment transactions drain callbacks
through `withSettledTransaction`: a driver rejection cannot release replacement exclusion while
Git or filesystem work still runs.

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
Each selected repository first takes the mutation lease; a live API writer's lease holds repair
as `checkout`, including after its database connection drops. After API death the intent remains
untouched until that lease expires. It is then rechecked under the fresh-client lock, taken with
`SKIP LOCKED`: a repository a relink holds is passed over, not waited for, so the
sweep never acts on a live request's intent the moment that request rolls back;
the next tick sees it again. A dropped database connection releases that lock
before the request's Git writes finish, so the lock alone is not enough: a relink
also holds an in-process writer fence from before its relink transaction until its Git
writes and its own reconcile have settled, and the sweep passes over a fenced
repository too. A skipped repository emits an info log with `repositoryId` and
`reason` (`fenced` or `locked`), at most once per repository per five minutes. A
nonlocking MVCC read distinguishes a skipped locked row from a deleted row,
which is not logged as locked. Expired log-rate entries are pruned each tick.
The fence is per API process, which matches the single API the
stack runs; process death ends both the writes and the fence. A repository
without intent runs no Git. Repair
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
can act on a live request's intent on a folder import: after the request's
rollback when its own intent clear fails (the writer fence covers the clear's
round trips in this process, but not a clear that never lands), and between
recording the intent and taking the relink lock (the request then answers 409 and a retry restores the origin).
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

## Warn before checkout replacement (T780 PR3, first prefix)

Retry preparation and Rebuild checkout use the shared Escape-dismissable Dialog before posting.
It warns that replacement stops running terminal, Editor and runtime commands and retains
Editor unsaved buffers for review. Check repair remains an in-place check. This warning must
ship before the worker stop barrier; it changes no session lifecycle on its own.
