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
copies and every remote rebuild, including ordinary refresh and explicit recovery, build in a
fresh `<repoId>.rebuild-<uuid>` sibling and publish with `renameNoFollow` and `noReplace` only after
the build and its verification complete. A failure before the data restore (below) removes only that attempt's staging entry;
failed cleanup names both retained siblings. Once the restore has started, a failure keeps the
private replacement and its journal images. A clone interrupted after its `.git` becomes readable
therefore cannot expose a partial public checkout or finish ready on Retry.

The private tree must pass `usableCheckout` before publication, and the rebuilt tree is checked
again before detection is persisted. A build or verification failure after the move is final for
that BullMQ job (`UnrecoverableError`), names every retained aside by its basename so path
scrubbing cannot hide them, and requires a manual Retry with a new job.
Refresh lists this repository's exact `<repoId>.aside-<ISO timestamp with colon/dot replaced>`
siblings through fs-safe under the renewing root claim, before preparation and after a move or
failure. It records all nonempty-directory, file and link basenames, sorted oldest first, in
`repositories.checkout_aside_paths` (migration 0255). Disk discovery is the inventory evidence;
the stored list is informational and is not read to render the page. The rebuild's ready note
and failure text use the in-memory discovery list; no recovery decision parses a message.
Failure objects also carry the list as
`checkoutAsidePaths`. The queue appends those names after sanitizing a bound-query failure, whose
diagnosis remains `Database operation failed`; neither query values nor paths are recovered from
error text. Discovery never follows links, restores or removes an entry. `renameNoFollow` with
`noReplace` claims a directory name with mkdir before rename: a death between them can leave an
empty `<repoId>.aside-<time>` directory while the old tree still stands at the checkout. Discovery
omits empty directory claims from both the notice and column, leaving them on disk. Review the
chosen tree's contents before undo; age alone does not prove it contains the original files.
A death between rename and recording is recovered by listing on the next Retry, including
legacy siblings absent from the row. A failure of the final `persistDetection` write remains
retryable. Before attempting the move, the owned inventory write stamps
`repositories.checkout_aside_job_id` with the current pending preparation's job ID (additive
migration 0256, declared last). Usable-checkout and held-task redeliveries of that same job
recover notice ownership even if the rename transaction's reply was lost. They
reconstruct its notice even when the queue has replaced its error copy. A later ordinary refresh
has a different admission ID and restores ordinary status-message clearing: old aside names
remain in the inventory, but do not become a permanent ready warning or annotate unrelated
refresh failures. A new rebuild reports all retained trees again. No message text gates this policy.

Undo requires choosing the original tree after reviewing **all** retained names: an older attempt
may have left a partial tree in a later aside. Once preparations and interactive commands have
settled, keep the current replacement at a separate name, then rename the chosen aside back to
the free destination. The aside retains the old tree, not later work. Unfinished `.rebuild-*`
stages retained after a death or refused cleanup are not swept or adopted by refresh.
Extraction stages and deletion-time leftovers remain separate board findings (T486 members 1/5);
this change adds no removal policy. Neither rebuild nor Retry deletes the preserved tree. A
read-only folder import is re-scanned as before, and a repository with no remote and no folder answers 409 without
touching its row.

T486 deployment/rollback: apply additive migrations 0255 and 0256 before loading the worker/database
barrel. Settle preparation work before reverting the code and rebuild the database library from
the reverted revision. Keep both migration files and columns applied, and retain every `.aside-*`
and `.rebuild-*` sibling. Reverting restores ordinary remote cloning in place and notice-loss
risks; it neither restores the original tree nor removes retained data.

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
code clears when an ordinary preparation starts or detection succeeds; a recovery keeps the exact
admitted code through worker and enqueue failures, including `source_repair_needed`, so the guidance
continues to name the original cause, unless the failure itself proves one: a source folder that fails
its proof before any move records `source_repair_needed`. A second refresh sent while the recovery is queued or running
answers 409, and a preparation stranded by a stop keeps its code too. A recovery job first
re-checks the checkout: one that is
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
replacement drops the legacy mirrors and is restored through the ordinary writers without a Git commit:
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

Recovery restores the private tree and publishes it in one database transaction. The task key,
project-state key, plan-mirror key and plan-patch key precede repository and projection rows;
the ordinary writers use that transaction's savepoints, with no pool calls from inside it.
The keys and the row are held for the whole restore, not only the rename: a task Start waits up to
its 5 s bound on the tasks key, a plan edit answers busy meanwhile, and a recovery that meets an
ancestry-changing plan edit holding the patch key past its 1 s bound fails retryably, keeping its
replacement.
Only the outer commit, after `renameNoFollow`, advances state bases, watermarks, plan stamps and
outbox acknowledgements. A refused restore or publication rolls those changes back, retaining
the private tree and its images. A death before rename leaves the old bases and an unpublished
replacement; Retry rebuilds again. A death after rename but before commit leaves a complete
restored checkout with old bases; after the dead claim expires, Retry's usable-checkout path
imports that output and repairs the stamps when its importers succeed. They are best-effort: one that
fails is logged as a warning, the row still goes ready, and the old bases wait for a later sweep or
refresh. No connection spans the clone or copy. The
transaction callback drains before the root claim/session barrier releases, including after a
connection failure. Legacy committed private intents still use the abandonment handling above.

T602 rollback: settle all preparations, then revert API and worker together. There is no migration
or data rollback. Keep every aside, private replacement and journal image. Reverting restores the
early-base-commit and repair-code relabelling hazards; it restores no checkout automatically.

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

## Checkout access during replacement

`@haive/shared/checkout-access` is the server-side admission policy. `read` requires ready;
`mutation` admission requires ready, no owed preparation (`refresh_pending`) and no foreign live
root claim. Explicit `repair` availability also permits an error checkout for raw attachment
reads, attachment removal and remote configuration repair. Neither admits cloning.
`preparation` requires the actual renewing `RootClaimHandle`, verified against its private runtime
registration, repository ID, preparation kind (`rebuild` or `refresh`) and the live row's owner.
A boolean, copied object, another repository's handle, expired/replaced claim or released handle grants no permission. Plan mirror and project-state callers carry this verified handle through `withRootClaim`, including the private
restore's nested import or writer. Legacy preparation imports retain their existing implementation
and remain follow-up work.

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

The policy applies to attachment upload/raw/single-delete/folder-delete, remote relink
and its reconciliation sweep (one info line per checkout hold, redriven after release), and
whole-plan deletion (the lease spans its database deletion and both physical mirror removals). Attachment lists and database-only plan list/detail/node edits
remain available. A task whose repository was deleted can remove its attachment rows DB-only,
without guessing a filesystem root. The raw route's error recheck preserves ordinary missing-file
and containment errors when the checkout is still ready. Ordinary ready fast-forwards do not hide read-only access.

Plan mirror writer/importer/reconciler, refresh, dirty sweep and boot stamping apply the shared
`projection` policy inside task-key → plan-domain → repository `FOR NO KEY UPDATE` locks.
The stronger row lock excludes non-key claim/status updates; acquisition uses the existing 250 ms
late-lock bound; the task key has the existing five-second admission bound, and hold
diagnostic/outbox writes are bounded separately at 250 ms. Ready with no foreign live root owner is required; owed work alone permits a
ready scan's import. A hold reads/writes no checkout data, leaves the mirror dirty (a clean row's
revision is bumped once, a dirty row's is left alone) and records the fixed `checkout_unavailable`
reason, so a later sweep retries; a held boot stamp only logs. A held initial import
cannot be turned into deletion of its incoming mirror on that retry.

Project-state writer phases, journal recovery, the sync and the task-end rules apply the same
`projection` policy as one plain `SELECT` (`checkoutUnavailable`, `project-state/write.ts`) after the
repository row is held `FOR NO KEY UPDATE`, inside the locks each already takes (task key where it
takes one, project-state domain, row). No lock or order is added: a claim acquire, renew or
release is an autocommit `UPDATE` of that row and waits behind it, and the sync now takes the row before
its final read instead of after it, so that wait covers the bounded read. The scope is the ambient
`planCheckoutAccess()`. A caller that holds its own claim carries it (`withRootClaim`, the plan
mutation lease, Undo's edit claim around both its set-aside and its re-sync); every other caller runs
`projection` with no owner, which refuses a status other than `ready` and any live root claim.
Writer phases and the recovery restore throw `ProjectStateCheckoutUnavailableError`, a
`ProjectStateCheckoutHeldError`, after the open-git-operation and live-reset checks, which keep their
text and priority. The sync judges the policy before its final read of the checkout, so a foreign
generation is never read, and answers `{ outcome: 'held', code: 'checkout_unavailable' }`: never
`deferred`, which `set-aside.ts` counts as synced, and never a throw. A hold changes no revision,
journal, base or ledger. `refreshProjectStateOutcome` answers `held` with reason `checkout` and stores one
fixed reason on a dirty outbox row only, so the sweep retries once the checkout is ready; Haive-data
Save reads that as `checkout_changed`. A task-end rules reconcile refused the same way writes neither
`AGENTS.md` nor the rules region and keeps its obligation. Push preparation wraps a hold in its
"nothing was pushed" error, so the step fails and Retry runs it once the checkout is ready. The watcher's
admission (`admitWatchedCheckout`) already refuses the same set plus holder tasks, so it has no
separate gate. `completePreparationImports` skips its legacy-mirror fallback after a held sync, which
would otherwise import legacy files over units the record carries.

Explicit plan Save/Pull hold a renewing mutation lease across preparation and the complete
Git/reconcile/recovery lifetime, acquired before their existing merge/domain/row locks. Nested
plan operations use that registered owner. The plan push helper accepts only the same verified owner when committing portable state; an
unrelated claim still refuses. Per-command Git and mirror-writer file checks stop an
unproven/expired owner before another physical step (set-aside and put-back moves are not checked one by one); projection transaction callbacks drain
before lease release after driver errors. Task/worktree-holder and open-Git-operation refusals
are retained. The independent `project-state/save.ts` admission is unchanged. Save/Pull answer 409
while a refresh is owed, the status is not `ready` or another root claim is live. Held, the lease
refuses Start, attachments, reset, verify, relink and plan deletion for the whole operation, and a
refresh or rebuild waits behind it (`RootClaimBusyError`). A lost or unproven lease refuses further
Git, recovery's included, so a half-done merge stays as an open Git operation until a person acts.
See the [plan mirror contract](plan-canvas.md) for the private restore, lock order and retry details.

The remaining independent entries in the T780 analysis are **not yet covered**: independent
Haive-data Save, project-state set-aside, kept-metadata and private-replacement recovery, conflict
answers (`project-state/resolve.ts`), initial detection/legacy imports (a redelivered
`completePreparationImports` holds no claim, so a held import waits for the watcher's hash comparison),
task file/archive/root resolvers, scope/code previews, onboarding/upgrade/data/snapshot
status, runtime ensure and DDEV control. They still need the same policy at their admission/locked
boundaries, with task-key → domain → repository-row order and dirty/outbox obligations retained
on holds. Interactive mount suspension is described below. Do not infer complete checkout exclusion from the
attachment/remote/deletion and plan-mirror coverage.

Rollback: settle active attachment, remote, plan-delete, plan Save/Pull and mirror operations and all preparations, then
revert the API/shared/database code together and rebuild shared/database from that revision. There
is no schema migration. Preserve relink intents, dirty/outbox rows and every aside/staging sibling.
Rollback reopens the covered races; it never moves an aside back automatically.

T780 PR2b-2 rollback: revert its code commits; there is no migration. Dirty outbox rows, write journals
and their fixed reasons stay and the sweep retries them; nothing is rewritten or moved. Reverting reopens
the project-state races above.

## Remote relink reconciliation

Relink and reconciliation hold the checkout mutation lease before their remote advisory key
and intent/row locks. Repair on an error checkout stays available; cloning and a foreign claim hold work without
consuming the relink intent. The route uses a dedicated fresh client for its Git transaction,
keeping the request pool free. Both reconciliation and attachment transactions drain callbacks
through `withSettledTransaction`: a driver rejection cannot release replacement exclusion while
Git or filesystem work still runs.

`POST /repos/:id/remote` commits a credential-free UUID in
`repositories.remote_relink_intent` before the relink transaction or its first Git
mutation. Recording intent uses a separate fresh database client and a short
transaction with a bounded repository row lock. It stores no URL or credential.
A failed intent write answers 409 before changing Git; a busy lock retains the
ordinary busy refusal. The relink transaction then takes the remote advisory key and the row
`FOR KEY SHARE`, verifies that its token is still current, inserts the required audit, changes
Git and takes bounded `FOR NO KEY UPDATE` only for its final compare-and-set.
Concurrent non-key writers can finish during Git; only supplied relink columns are replaced.
See [Integrations](integrations.md#audit-rows) for the lock order and audit comparison. A token
already settled by the sweep, or superseded by another request, refuses before any Git mutation.

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
and non-null intent under the remote key and repository KEY SHARE, and aligns origin with the
committed row, clearing push overrides when replacing an existing origin. It
rechecks the remote, paths and token under bounded NO KEY UPDATE before clearing the token
in that same transaction; a changed committed remote retains intent for another repair.
Fresh clients end with
`end({ timeout: 5 })`. If the fresh read or Git repair fails, intent remains
for another attempt and the request returns 500 explaining the uncertain outcome.
A failure before this request records intent leaves Git alone, including a
folder import's Git-only origin whose database `remote_url` is null.

A successful relink leaves intent for locked reconciliation. For a request with
no predecessor repair, a known refusal before any mutation clears its token,
as does a successful undo while the relink holds the remote advisory key and row KEY SHARE.
An unreadable previous-remote
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
untouched until that lease expires. It is then rechecked under the fresh-client remote key
(a nonwaiting try) and KEY SHARE row lock, taken with `SKIP LOCKED`: the advisory try-lock
passes over a live relink or gate-4 origin writer; SKIP LOCKED passes over retained FOR UPDATE
takers (delete and onboarding/upgrade admission), since KEY SHARE is compatible with relink's hold. The
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
KEY SHARE hold, and an uninterruptible kernel I/O wait cannot be made to exit by SIGKILL.
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

## Warn before checkout replacement

Retry preparation and Rebuild checkout use the shared Escape-dismissable Dialog before posting.
It warns that replacement stops running terminal, Editor and runtime commands and retains
Editor unsaved buffers for review. Check repair remains an in-place check. The warning
requires confirmation before submitting a preparation that can replace the checkout.

Each confirmation owns its sending state by request object identity. Dismissing a slow
request and opening another warning (including one for the same repository) leaves the new
warning enabled; the earlier completion clears only its own dialog and sending state.
The shared Dialog panel caps its height at `calc(100dvh - 2rem)` and scrolls vertically so
Continue remains reachable in a short viewport. Existing callers retain their own inner
scroll regions and height limits; caller classes can override the shared defaults through
`tailwind-merge`, including the fixed-position task history panel's responsive height cap.

## Interactive attach fencing

Editor grants/cookies and HTTP/WebSocket admission bind the repository's Redis epoch; Browser
attach repeats checkout admission, and Terminal understands close code 4426. Before the first
replacement, the current epoch is null, so legacy cookies with a null epoch remain valid.
Attach admission starts no stop or rebuild. The authenticated interactive-status endpoint is
passive and returns the owned target's status and epoch with `Cache-Control: no-store`.
Migration 0254 adds only nullable checkout_session_reason, declared last; Retry clears that
column. Keep the additive migration on rollback.

The VNC epoch sender and the Editor/VNC session boundary use the same epoch as API admission.
A fresh pane obtains its accepted epoch through the
passive status endpoint; a changed epoch requires explicit reopen. An absent epoch is
still a null expectation and refuses a non-null current epoch. Terminal and shell clients
never automatically reconnect after replacement; Editor grants bind the epoch on the
server and each proxied request rechecks it (database lookups and one Redis GET; task targets also resolve their repository).
Apply `0254_checkout_session_reason.sql` before reloading API/worker with the new schema.
DDEV replacement discards changes since the saved snapshot.
A failed status poll closes admission until a successful poll, then requires explicit reopen.

## Interactive mounts at replacement

The rebuild commits `cloning` with `checkout_session_reason = 'draining'`, then recounts
checkout holders and worktrees in a short task-key transaction **before** suspending anything.
A task admitted before cloning must finish admission before that recount; subsequent starts
and revivals refuse the committed status/root claim. The rename transaction retains its final
recount as defense in depth. No database connection spans draining or Docker work.

The single worker closes interactive admission synchronously and drains Terminal opens and
Editor/runtime boots already in flight, with `CHECKOUT_DRAIN_TIMEOUT_MS` (30 seconds, injectable).
A timeout raises `drain_timeout` before notifications, stops or rename. Once drained it rotates
the Redis epoch, closes PTYs with `repository_rebuilt`, enumerates Docker containers in **all**
states, and stops repository/task shells, Editors and app/DDEV runners, including detached warm
shells and failed root tasks. Holder/worktree guards still govern rebuild eligibility.
The barrier remains held through replacement/detection and releases in `finally`.

The epoch write and all terminal closers share `CHECKOUT_TRANSPORT_TIMEOUT_MS` (10 seconds,
injectable); expiry raises `session_transport_unknown`. Container discovery, legacy mount
inspection, sequential stop/removal and the final absence listing share
`CHECKOUT_DOCKER_TIMEOUT_MS` (five minutes, injectable); expiry raises `docker_unknown`.
The Docker budget is deliberately a generous fixed aggregate bound: it covers a hung initial
listing too, before a candidate count exists, and leaves room for many ten-second stop graces.
An unusually large or slow set that exhausts it defers safely rather than moving unverified mounts.
Both errors release the process-local admission fence and unwind the root claim before the queue
applies the existing 30-second retry and 30-minute submission-age cap; the cap is checked on
failure, so an attempt already running can finish its bounded phase past that age.

Deadline timers clear on success or failure. Redis/Docker requests already sent cannot be
cancelled: their eventual rejections remain observed, and expiry checks after each await prevent
an abandoned attempt from starting another closer, Docker call or rename. A late Redis epoch
write can only fail closed (even a grant from a newer attempt then needs explicit reopen).
A terminal closer already running holds its original session snapshot. A Docker stop/remove
already sent names an immutable container ID, so its late completion cannot target a replacement
container; the next attempt independently enumerates and proves absence before proceeding.

Removal uses immutable Docker IDs, SIGTERM with ten seconds' grace, and `remove({ v: true })`.
The reuse-repair paths for DDEV/app runners also pass `docker rm -v`. This removes anonymous
volumes only: DDEV's Dockerfile-declared `/var/lib/docker` stores its nested image cache and DB,
and a new runner gets a fresh one anyway. Editor `/udata` and extensions, provider auth, the
repository volume, DDEV CA and registry cache are named volumes and survive. An app runner mounts
the named repository volume; any image-declared anonymous volumes are likewise removed. A new
DDEV runner restores the ordinary saved snapshot; changes newer than it are lost on replacement,
not retained in a usable detached anonymous volume. A successful second listing must prove the
selected containers absent before rename.

`CheckoutSessionsBusyError.reason` is structural and is persisted as `checkout_session_reason`
while draining, deferred and failed. `foreign_container`, `container_remains` and unrecognized
reasons require repair: the owned job fails unrecoverably, writes `error` with that code and
releases its pending owner without moving the checkout. `docker_unknown`,
`session_transport_unknown`, `drain_timeout` and `already_suspending` can resolve; retry them every
`CHECKOUT_SESSION_RETRY_MS` (30 seconds) without spending an attempt, for a total
`CHECKOUT_SESSION_DEFER_MAX_MS` (30 minutes from the durable job submission timestamp). Expiry
uses the same visible error/Retry state. Some sessions may already be stopped after a Docker
failure. The stranded-preparation sweep does not count permanently blocked or expired deferred
jobs as live; an active `draining` preparation still counts. A stranded failure clears the old
suspension reason so the stranded-preparation explanation is visible. The web uses
`checkoutPreparationBanner` keyed on status and code, never on display-copy presence.

Shells, Editors and runtimes stamp `haive.checkout.identity` with the root's decimal device/inode
pair, read through fs-safe. A different stamped inode requires replacement. A missing legacy
stamp is always kept; a changed device number with the same inode (overlay/tmpfs remount)
is also kept. No replacement history or container creation time is consulted. Identity repair
uses the ordinary runner recovery path: DDEV/app runners still recreate for another workspace
or a failed nested dockerd during a running step. Editors with a different stamped inode are
removed even when their registry is held. The eligible rebuild stop pass is the primary guard;
it preserves named Editor hot-exit data for review.

Upload Retry (`handleExtract`) commits cloning and takes the same suspension barrier immediately
before its archive swap, after validating the private staged tree. The old root remains in place
if stopping fails; the barrier stays held through detection and releases on every outcome.

The worker writes a persistent Redis epoch before closure. Editor grants/cookies bind it;
HTTP/WebSocket admission and browser upgrades recheck status and epoch, including after ensure.
Terminal exit frames/retained exit keys carry the reason and close code 4426. No keystroke runs SQL.
Keep Redis persistence (AOF/noeviction). An explicit Redis flush makes a post-rebuild non-null
epoch cookie stale and requires reopen. One narrow stale-cookie case remains: a cookie granted
before the first rebuild carries null; after a rebuild **and** a Redis flush it matches null
again. Container identity still protects the mount, but that stale tab can save its retained
old buffer into new files. This change does not make epochs durable outside Redis.

The lifecycle fence is a per-process Map and relies on **one worker per install**, as compose
runs. Two workers can admit a boot in one process past the other's drain; horizontal worker
scaling needs a shared lifecycle fence before it is supported.

Deploy API, worker and web together after draining preparations, interactive boots and task
work through maintenance. Apply migration 0254 first and rebuild database/shared libraries.
Use `pnpm docker restart api worker web` for deployment after that drain; never restart live
services as a test. Legacy unstamped containers survive deployment and ordinary next ensures
regardless of replacement history. A worker recreation still interrupts PTYs.
Rollback settles work, reverts packages together and rebuilds libraries, **keeping migration
0254's file and its column applied**, all aside/staging directories and named Editor/auth/cache
volumes. Reverting cannot revive stopped commands and restores the older mount-reuse hazard.

Existing surfaces close or refuse stale attachment. Editor, VNC and terminal reopen controls
require a ready checkout and an explicit user action, so a surviving pane cannot silently
resume work against a replacement checkout.

Unreadable Docker identity labels preserve app/Editor runners. DDEV wraps that probe failure
in `RunnerProbeError`, retaining its transient retry classification. Filesystem identity failures
still refuse admission; the pre-swap stop/absence barrier remains the replacement guarantee.

The web's Retry preparation and Rebuild checkout actions open the shared Escape-dismissable
Dialog before posting. It warns that commands in terminals, Editors and runtimes stop and that
Editor buffers survive for review; Check repair remains an in-place check. Editor/Browser panels
poll the authenticated `interactive-status` endpoint, whose structural status and replacement
epoch drive `checkoutSessionBanner`. A changed epoch is noticed even if cloning and ready both
happened between polls. The old surface unmounts and stays closed until **Reopen session** is
clicked after ready. Terminal code 4426 keeps its output visible and offers **Reopen terminal**
once that same endpoint reports ready. Neither path reconnects automatically for a rebuild.
The replacement banner asks users to review retained buffers before saving. Error or
status-message copy alone never drives a replacement banner.
