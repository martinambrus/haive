# Worker restarts

**A step keeps the status that says what it is waiting on, even while its apply runs.** A
continuation (the advance an ended CLI run queues) re-enters a `waiting_cli` step. For a
form-bearing step it used to re-validate the saved answers and flip the row to `running`. A worker
that died from that point on left a `running` row, which boot reads as a pass that died before
doing anything, so it reset the step: every agent row deleted and the answers cleared. Now a
continuation that finds its answers saved uses them as they are, and the row stays `waiting_cli`.
Values the job carries are ignored there, since a parked step's only source of them is a submit
redelivered after it was applied. A submission, a retry and a first run still flip to `running`.

**Nothing starts before the configuration store answers.** `bootstrap()` runs through
`retryWhileConfigUnavailable` (see [Error diagnostics](error-diagnostics.md), "Configuration store
outage"), and the step engine, the sandbox reap, the reconcile, the queues, the module jobs and
`haive-worker ready` all follow it, so a worker booting during an outage waits up rather than half
starting. The boot data migrations are part of the retried `bootstrap()`, except the two global-store
repairs, which start after `haive-worker ready` and retry in their own loop (see
[Global knowledge base](global-kb.md)). Any error other than the typed outage still exits 1.

**Boot hands a dead worker's active jobs back before it starts its own.** BullMQ keeps a job
`active` under its lock when its worker dies, and the task and cli-exec locks are 30 minutes, so
such a job used to run only once that lock expired. `requeueOrphanedActiveJobs`
(`queues/boot-requeue.ts`) moves each one back to waiting before this process starts a Worker, and
only while `getWorkersCount()` reads 0: a connected worker may still be running them, and a count
that cannot be read moves nothing. The count is read once and nothing locks it, so like the reap and
the reconcile around it this relies on the one worker per install compose runs (a fixed
`container_name`): two workers booting together on one Redis could each read 0 and requeue a job the
other had just taken. Every task job is moved; on cli-exec only an agent run and the
version refresh are (`cliExecJobRequeuedAtBoot`), the kinds known safe to run again at once, and the
rest wait out their lock as before. The reconcile below ends a parked step's started runs, so their
jobs exit on the finalized row; any other started run runs again, as its lock's expiry would have
made it. A move never counts toward
`maxStalledCount`, so a job that kills the worker would come back at every boot: past
`BOOT_REQUEUE_LIMIT` requeues of one job, it is left to its lock and BullMQ's own count.

**Boot recovers a parked step and resets only a step that has nothing to lose.**
`reconcileOrphanedSteps` runs before any queue starts:

- A `waiting_cli` step the task is on has its orphaned runs ended, and unstarted runs no queued job
  owes are ended too. The task's epoch is then fenced by a compare-and-swap on the state read, and
  the step is re-driven at the new epoch, so every advance queued before the restart is stale. A
  step the task has moved past is requeued rather than re-driven, and every run it still has is
  superseded: one that ended later would resume it at whatever epoch the task was at by then. An
  advance for it queued before the restart is dropped once it finds the task pointing elsewhere,
  since every advance that carries no answer is queued for the step the task points at.
- A `running` step the task is on is decided by `bootRecoveryAction`. With agent work behind it (a
  finished loop pass, an agent row, or a run of its own nothing superseded), it is a parked step
  whose park write was lost. It is demoted to `waiting_cli`, guarded on `running`, and recovered
  like the parked ones. Without agent work it is reset and re-run. That recovery reset keeps durable
  `apply_receipt` records and their approved detect/form inputs; explicit Retry or an
  upstream rerun clears receipts, including a pending downstream row that holds one.
  Explicit resets also advance a pending downstream `11g-save-database` row's generation:
  its durable decision lives outside the step row and has no apply receipt. A pristine
  pending save row is reset too, avoiding a separate read that could race publication.
  This applies to step/task Retry, fan-out and loop Resume, Retry with AI, provider
  switches, Skip's task move, and worker recheck/fix-loop/revise resets. The task move
  includes only pending durable rows downstream in the same round; a task restart
  through START settles pending save rows as well. Recovery preserves their generations.
  Explicit resets and a journal-backed 08e batch requested on a reopened form increment
  `rerun_generation`;
  recovery's epoch bump fences old jobs without declaring new work. Environment-image
  builds reconcile a completed tag carrying their `haive.apply-id` label. Custom
  migrations reuse a recorded success only after its durability snapshot was recorded
  complete, and fail with inspect/Retry/Skip guidance when their outcome or durability
  is unknown, rather than executing again.

Rollback: revert the code and keep the columns (0233 and 0234 are additive). Old Retry paths
do not clear receipts, so before rolling forward again run
`UPDATE task_steps SET apply_receipt = NULL`. Never drop the columns: the runner never re-runs a
recorded migration, so a dropped column stays missing; if one was dropped, also delete its
`schema_migrations` row (`0233_deterministic_apply_receipts`,
`0234_snapshot_decision_generation`) so the guarded file re-runs.

**Check-run measurements preserve recovery identity.** `_check-runs.ts` uses the step-row id,
round, `rerun_generation` and loop iteration, following step 11's learning outcome identity
(#1168); an epoch bump alone does not declare another attempt. Recording is observation
only: every apply replay executes checks as it did before recording existed. A compare-and-swap
takes over the same attempt row from any prior outcome, resets its start/end timestamps and
finalizes the latest observation, without retaining command text or output. An abrupt death
leaves `running`; a thrown/cancelled command finalizes `interrupted` in `finally`. Both display
as incomplete with no suite duration until recovery runs again. Explicit Retry advances the
generation and keeps earlier rows. Recording failures only warn and never block execution;
a failed finalization may leave a running record. No recovery sweep invents a successful
check or zero duration.

**A running task that nothing drives is taken over.** A `running` task whose current step row is
missing, `pending` and not parked, parked with a heartbeat older than the cutoff, `running` with no
run left to wait for, or finished (`done`/`skipped`) with nothing after it, while the task queue holds
no job for it, is re-driven by `redriveStalledTasks` (`queues/stalled-redrive.ts`):
once at boot after the reconcile, whose own re-drive enqueue can still be lost, and every minute for
a task idle five minutes, for a hand-off lost between boots. It bumps the epoch under the task row's
lock and re-checks the row in the same statement, so a step a pass claimed since the candidate read
is left to that pass. A finished row is the job that died between ending the step and pointing the
task on, and its advance takes the duplicate-delivery branch below, which re-drives the hand-off. A
current row that FAILED is the job that died between failing the step and failing the task; no
advance can run it again, since every write refuses a failed row, so the sweep fails the task at
the epoch it read through that job's own hand-off (`finishFailedStep`), which also records the
failure's hint, arms its allowance watch and logs `step.failed`. An advance that meets such a row
first does the same rather than running it, since every reopen (a step Retry, both Resumes,
`retry_ai`, a CLI switch, the allowance auto-resume) resets the row first; `advanceStep` hands a
failed row back as its failure, as it hands back a done or skipped one. A
START on the queue is no such job for a task still waiting to start (`taskQueueOwed`): it only claims
such a task, so one a dead worker left `active` under its 30-minute lock would otherwise hold a claimed
task for that long and then do nothing. It does hold a task parked or running on its first step,
since it runs that step inside the job (below). A `settle-stopped-task` job owes no step either
(`taskQueueOwed` skips it): it only releases what a failed task holds.

**A step whose CLI provider is switched off is held.** A fresh step that dispatches a CLI or is
provider-sensitive is held (`providerHoldFor`, `task-queue.ts`) while the provider its task, step or
saved choice names is listed but disabled. The provider is the one the dispatcher would refuse
(`resolvePreferredProvider`): on a composed-LSP task a saved pick outside the lock's set is skipped,
so a switched-off one does not hold the step and the task's own CLI is checked instead (see
Provider lock in [Sandbox](sandbox.md)). Precedence is pause, then module schema, then provider.
The hold is evaluated only for fresh entries, never for a continuation, so a disable mid-step fails
with the dispatcher's named skip and Retry works once the provider is enabled. START takes the same
check and queues the advance; a held first step leaves a `pending` row without the park stamp, which
the stalled sweep treats like a missing row and re-drives. Only the `default` role is checked here;
role and seat picks rely on the dispatcher rule. The hold copy names both recovery actions:
enable the provider again or switch the step's CLI.

A provider park writes `task_steps.provider_wait_provider_id` (nullable uuid, migration 0236) on
the first park and on each re-park tick. Every other fenced park defaults the marker to NULL,
including a pause or module-schema wait that overtakes it, and a step claim clears it. The
derived badge reads it only on the current pending row with a live `waiting_started_at`, for
a running task that is neither paused nor dead. Reset paths that close the park marker therefore
cannot keep the badge alive. The task list explicitly selects this column; detail reads the
whole step row.

Before saving a provider disable, Save and Rebuild read the authenticated, owner-scoped
`GET /cli-providers/:id/disable-impact`. It counts remaining fresh default-slot bindings to that
provider on non-dead, nonterminal tasks (including tasks waiting to start or resume), using the
same CLI preference resolution as the step display. Continuations, deterministic steps that are
not provider-sensitive, implicit defaults and other owners' tasks are excluded. Repository-dependent
`shouldRun` skips are not predicted, and the confirmation says so. A successful nonzero preview
asks for confirmation; two zero counts skip it. A failed preview also proceeds without a dialog,
since this read is advisory and PATCH remains authoritative. Rebuild sets its build gate before
persistence clears dirty state, defers polling until the request finishes, and restores the previous
build state if confirmation is cancelled. Save and Rebuild share a synchronous in-flight
guard acquired before either awaits the preview, held through confirmation and persistence
(and the rebuild request), and released in `finally`. A second action is refused while the
first holds it, so it cannot overwrite the confirmation resolver. Both controls reflect the
shared pending state.

**A park whose poll chain was lost is re-driven.** A parked row (`pending` with
`waiting_started_at`: a runtime slot, a pause, module schema setup, a required integration or a disabled explicit CLI provider) is
driven by a chain of delayed advances, each queueing the next and rewriting the row's `updated_at`
(15 s, 30 s, 5 s; integration and provider waits use 30 s). A
chain whose job was lost (Redis restored without it, a queue cleaned by hand) leaves the row parked
with a stale stamp, and the sweep takes it once the ROW's stamp is older than the cutoff. The task's
stamp cannot tell a dead chain from a live one, since a tick that finds the pointer right never
writes the task row; it stays the throttle (the fence stamps it). Boot (`staleMs: 0`) takes a park
whose tick was lost with Redis the same way. The re-driven advance re-enters the park: pause and
module setup refresh the heartbeat and queue the next tick with the marker kept, and the runtime park
asks admission again and re-joins its FIFO at the tail if its ticket was lost.

**A running row with no run left to wait for is re-driven.** It is a step re-opened by the allowance
auto-resume, a loop or fan-out Resume or `retry_ai`, which commit the re-open before they queue the
advance: a rejected add leaves the row as it is and, for the auto-resume, with the watch already
cleared. The sweep takes it when row and task are older than the cutoff, the queue holds no job and no
START for the task, and the row has no run that is neither ended nor superseded (started or not: a fan-out
behind queued agents sits idle on its own). The candidate query and the fence share one live-run definition, so a
stale row with a live run is never a candidate and takes no task-row lock, and the fence re-reads it
in the statement that bumps the epoch. A START counts because it runs the first step inside the job,
so its row is `running`, `taskQueueOwed` files it under `starts`, and an apply that writes nothing can
idle past the cutoff. The sweep also leaves a candidate whose task, step and round a pass of this
process holds (`stepAdvanceHeld`, a read-only view of the set `holdStepAdvance` and the START take):
the queue read cannot see a pass whose job Redis lost (a flush, or a restore older than the job)
while its handler goes on, and re-driving it would abort the live pass at its next 2 s poll, discard
its result and run the step a second time. The hold lives exactly as long as the handler and is
empty at boot; a second worker process is not covered, since the hold is per process. A re-drive of a
running or parked row is an epoch bump and an advance, never a reset and never a write to the row
(the producers it repairs rely on the passes, agent rows and fix context the row keeps): the epoch
stales a stamped job queued earlier, while an unstamped one (a form submit, the usage poller's own) is
serialised by `holdStepAdvance` and re-enters by status. The "redrove a stalled task" line carries
`shape`: `parked`, `running`, `waiting_cli` or `handoff`. A `waiting_cli` row whose runs have all
ended is a candidate too (`idleWaitingCliRow`): the run that ended last queues the step's
continuation (`resumeStepIfLinked`, `cli-exec/resolvers.ts`), and a queue that refused it, or a
Redis restored without it, leaves a parked step with nothing to wait for. Its cutoff counts from the
end of the row's last run as well as from the row's own stamp, since the cli-exec handler stamps the
row (`markCliParkBegin`) only after the end has committed, and not at all when the park marker is
already set or the stamp throws.

**Every recovery re-drive carries a deduplication id**, `advance-<task>-<step>-<round>-<epoch>`
(`enqueueRedrive`, the default enqueue of the sweep, the boot reconcile and a dead task's revival):
one live job per bumped epoch, so an add retried after a lost reply collapses onto the first. BullMQ
frees a deduplication id when its job completes, fails or is removed (MEASURED on 6.3.12), while a
plain custom jobId stays with a completed job (`removeOnComplete: 100`) and silently drops a later add
of it. Park ticks, continuations and the forward hand-off carry none: they share one epoch, and a
successor added while its predecessor is active would collapse onto it (BullMQ collapses onto an
active job) and end the chain or lose a fan-out agent's wake-up. A recovery enqueue the queue
refuses is asked again in the process (`retrying`, after 1 s and then 3 s), and so are three adds
that carry no deduplication id: the continuation, the usage poller's auto-resume advance and the
pull-request poller's finalize advance. A retry of one of those after a lost reply can queue a
second advance, which is absorbed: `holdStepAdvance` serialises it behind the first, a row already
`done` is a duplicate delivery that re-drives the chain only when `advanceChainHasMoved` shows it
never moved past the row, and a stamped job is dropped once the epoch has moved. A continuation
still refused after its retries waits for the sweep's cutoff; the pull-request poller's waits one
3-minute tick, since every tick re-drives a merged task still parked (`pollTask`).

**An answer whose advance was lost is re-driven.** The submit route saves a form's answers, clears
its `waiting_started_at` and queues the advance; when that advance never reaches the queue, the row
stays `waiting_form` with no park marker and nothing moves the task. The sweep takes such a current
row (`answeredFormRow`) for a `running`, `waiting_user` or `waiting_pr` task once the row itself is
older than the cutoff and the task queue holds no job for it, under the same fence: the status the
pass read, the epoch, the step and round, and the row still an answered form. A parked form, an
answer whose job is queued and an answer newer than the cutoff are left alone. For `waiting_pr` the
task-level cutoff gives way to the row's, since the pull-request poller rewrites `tasks.updated_at`
every few minutes. For a `waiting_user` or `waiting_pr` task the fence stamps the row's `updated_at`,
so an advance dropped before pickup is re-driven once per cutoff rather than on every pass, and it
locks that row before the task row, the order a Retry takes (the other order deadlocked); an action
whose NOWAIT re-check meets that lock answers 503 and can be sent again. A
`running` task's fence locks only the task row: it reads the row inside the update its epoch guards,
and that update's stamp on the task throttles the next pass. A dead `waiting_user` or `waiting_pr` task revived
with an answered form gets that advance at revival (`jobAfterRevive`).

The same sweep covers the two other jobs that can be lost with nothing to notice. A task left
`queued` past the cutoff with no START on the queue gets one, which the claim makes safe to
duplicate; `created` is left alone, since a deferred-start draft waits there on purpose. Every
route that starts a task moves it from `created` to `queued` before it queues START, after every
write that can fail (`markQueuedForStart`, `api/src/lib/task-start.ts`), under the repository's
task-creation lock, since a queued task holds the checkout and a checkout move holds that lock. The
api waits at most 5 s for each repository or plan key and row lock it takes there, and 1 s for the
shared new-work fence (`TASK_START_LOCK_TIMEOUT_MS`, `NEW_WORK_FENCE_LOCK_TIMEOUT_MS`), and otherwise
answers 409 with nothing created or queued; other `boundedLockWait` callers keep the 30 s default. So a
START that was lost or could not be queued is the sweep's to give, and the route answers as though
it had been queued. POST /tasks, `spawnPlanTask` (its seed included) and the global-KB enrich each
insert the task and claim its START in one transaction, taking that lock before the insert, so a
creation that fails there leaves no task; the enrich writes its KB entry in its own database first
and removes it again when the task transaction rolls back (an error anywhere inside it, the insert
or a write after it); an error after the commit keeps it. And a `waiting_cli`
current step with a run recorded before the cutoff that no cli-exec job owes, no run of its own
running and no task-queue job, is recovered exactly as boot recovers a parked step
(`recoverParkedStep`), bounded by `bornBefore`: only runs started or recorded before the cutoff are
ended, since a live worker may be starting younger ones. A step whose old runs all still have a job
(a pause, the per-task cap and the runtime reserve all hold jobs `delayed`) is left to them, and so
is a step a pass of this process holds (`stepAdvanceHeld`): a continuation that dispatches a next
wave records the run, sets the workspace up and only then queues it, with the row still
`waiting_cli`. The lost run never started, so its re-dispatch charges no orphan budget.

A `cancelled` task with a `task.cancelled` event five minutes old and no `task.cancel_finished` (the api commits the cancel before it queues the teardown) gets a CANCEL from the same sweep (`redriveCancelledTasks`), unless one is waiting, active or delayed; a finished or failed one in history does not count, since the finish record is what says the teardown ran, and the teardown is idempotent. The sweep waits for the newest `task.cancelled` event to be five minutes old, and the CANCEL job writes one of its own on every run that is not ignored (`markTaskCancelled`), so a teardown that keeps failing is re-driven at most once per five minutes (smoke case `rerunning-cancel`, `stalled-redrive-smoke.ts`). Each re-drive is a `task.cancel_redriven` event, and a task stops being re-driven after three (`CANCEL_REDRIVE_MAX`); cancellations older than seven days are not re-driven, since many predate the finish record. A task the re-drive no longer retries but that still holds a merge dir claim is given up instead (`abandonCancelledTeardowns`, started by the same sweep without being awaited, one pass at a time, since its dir locks can wait behind a long merge): capped with its last re-drive older than the cutoff, or with its `task.cancelled` event older than seven days whatever its re-drive count. Giving up keeps the CANCEL teardown's guard: it supersedes the task's runs, kills its cli sandboxes and goes on only when the listing shows none left, or the task keeps its claims for the next pass. Then it reports the merges left open (a failure stops there, with nothing released, and the next pass tries again), writes a `task.cancel_finished` event with `abandoned: true` and its reason (`re-drive cap reached` or `cancelled before the re-drive window`), and only then runs the claim release, the plan-merge discard and the re-sync, each logged and passed over when it fails. The event comes before the release because it is what frees the dir: a cancelled task with that record holds no claim (`liveClaimHolder`), so a pass cut off after it leaves only stale rows that the next claimer takes over. A re-drive whose CANCEL the queue refuses gives its `task.cancel_redriven` event back, so a queue outage never counts toward the cap. A task with a CANCEL waiting, active or delayed is left to it.

A Stop's settlement is re-driven the same way (`redriveStoppedTasks`). The Stop writes a `task.stop_settle_requested` event in the transaction that fails the task, with its `failedAt`, and the settlement writes `task.stop_settle_finished` with the same stamp once its teardown has run (`STOP_SETTLE_EVENTS`). A task still `failed` with a `completedAt` five minutes old, a request for that `completedAt` and no finish for it gets a `settle-stopped-task` job from the sweep, unless one for the task is waiting, active, delayed, prioritized or waiting on children (a queue it cannot read skips the pass; it is read only when some task is unsettled, and tasks with a live job are excluded before the batch is taken, so they cannot hold back one whose job was lost), at most 20 tasks a pass (`STOP_SETTLE_REDRIVE_BATCH`), oldest first. Each re-drive writes a `task.stop_settle_redriven` event for that stamp before it queues, and the sweep skips a stamp re-driven within the last five minutes, so a settlement that keeps failing is queued again at most once per five minutes, with no cap on the count, since the settlement is idempotent and a request never outlives a Retry; a refused enqueue deletes the event. Every event is matched on its `failedAt` against the task's own `completedAt` (both compared as `timestamp`, the column's type, so the session time zone cannot shift them), so a Retry or a later failure leaves an older request with nothing to match and the sweep passes it over. Writing the finish event, and capturing the failure the settlement checks it against, are best-effort: when either fails the teardown still runs and the request stays pending for the next pass.

The CANCEL teardown releases the task's `merge_dir_claims` rows once `cleanupTaskContainers` has returned and a docker listing (`listCliSandboxesForTask`, null on any failure) shows no cli sandbox of the task left (`releaseTaskMergeClaims`), each one under its dir's advisory lock, so a section the old pass is inside finishes first and a later section of it reads the task as cancelled and refuses. When that listing is not clean the teardown keeps the claims, skips the release, the report of merges left open (`recordLeftOpenMerges`, which otherwise precedes the release, and with it the report of a merge left committed, `recordLeftCommittedMerge`), the plan-merge discard and the scratch cleanup (they would remove a dir a fixer may still write), still runs the model unloads and the KB reconcile, then throws: the job fails, no `task.cancel_finished` is written, and the re-drive above repeats the whole idempotent teardown, at most three times, after which the teardown is given up as above and the dir is freed. A cancel that died before then keeps its merge dir held until the re-drive above finishes it; a crashed worker's claim stays held and the boot re-drive of the owning step resumes it ([merge conflicts](merge-conflicts.md)). A projection re-sync that does not finish during the teardown or the abandon pass is logged and left to the durable metadata sweep; it does not stop the release, the finish event, the plan-merge discard or the task-end re-sync.

A repository delete records its two cleanup jobs (per-project RAG databases, then runners, env images, `haive_repos` files and the repository's finished upload archive, `_uploads/<user>/<repoId>.<ext>`, whose failed removal only warns) as `repo_cleanups` rows inside the delete's own transaction, with no foreign key to the repository that is going. The api queues the jobs after commit, passing each row's id as `cleanupId`, and a queue that refuses them no longer fails the request; the handlers delete their row when they succeed. The same sweep (`redriveRepoCleanups`) queues again any row stamped `last_enqueued_at` ten minutes ago, or never stamped ten minutes after it was written (so it does not race the api's own enqueue), claiming the row on its stamp, counting the attempt only once a queue has taken the job (a refused enqueue puts the stamp back and spends nothing), and carrying it in the job id (`repo-cleanup-<id>-<attempt>`, hyphens, since BullMQ only tolerates a colon in a custom id as a compatibility carve-out for three-part repeat ids), and drops with a warning a row whose job a queue has taken five times (`REPO_CLEANUP_MAX_ATTEMPTS`) so a cleanup that never succeeds is not looped on.

A custom bundle left at `syncing` five minutes after its last update, with no waiting, active, delayed, prioritized or waiting-children job naming it, is marked `failed` with a reason by the same sweep (`reconcileStrandedSyncingBundles`), never re-driven: failed is what re-enables Resync and Replace ZIP. A Replace ZIP the user chose to keep the previous bundle for (`keep_until_success`) is instead restored from its durable record when the previous extracted tree can be verified (the stage and the previous directory's identity are recorded before either swap rename): the previous tree, item rows and archive metadata come back `active` with a warning, and the job's own re-delivery does the same. A record that does not parse, or whose path has a link or a non-directory in any component, fails the bundle; a fault reading or restoring one bundle is logged and leaves that bundle for a later tick, and the sweep goes on to the next. Recovery holds no transaction across the filesystem: a short transaction claims the row (status `syncing`, that age) and restamps `updated_at`, the tree is restored with no connection held, and a second short transaction settles only if status, `updated_at` and archive path still match the claim. A faulted attempt therefore waits another five minutes. The restamp is what keeps a second sweep off the row, so a restore longer than five minutes could be claimed twice; one worker per install makes that moot. A Replace complete that resumes the same upload while a claimed restore runs is admitted, and the settle then refuses, but the restore's renames can overlap the resumed ingest. The git-bundle sync tick writes only `last_sync_commit` and leaves `updated_at` alone, so it never trips a Git Resync's admission check. The routes need it less often than before: a zip complete keys the bundle and its job (`ingest-zip-<uploadId>`) on the upload, so a repeated or resumed complete finds both instead of making a second bundle, and a job that cannot be queued marks its bundle failed at once (`addBundleJobOrMarkFailed`).

The same sweep collects bundle storage leftovers once an hour (`bundle-orphan-sweep.ts`): an extraction stage (`.haive-extract-<pid>-<uuid>`, including one kept after a failed rollback), a replacement record (`<archive>.replacement.json`) and an archive that is no longer the bundle's current one (a superseded or failed upload), each matched by its exact generated name and older than 24 hours by its own mtime. It collects only in the directory of an `active` bundle or of a directory no bundle row names; a `failed` bundle keeps everything, since its previous archive or a kept stage can be the only copy of the old bundle, until a successful Resync or Replace makes it `active` or the bundle is deleted. A `syncing` bundle, an `uploading` or `completing` upload of the bundle, and any live bundle job naming the directory or archive skip it as well. An archive counts as owned when a row records its exact path or the same `<bundleId>/<basename>`, so a changed storage root never orphans a recorded file, and ownership is read again just before an archive is removed. Every removal goes through the fs-safe primitives and never follows a link; a link named like a stage is left alone. A queue snapshot it cannot read in 5 s, or one that reaches 1000 jobs, skips the pass; a pass visits at most 100 bundle directories, rotating, and a directory listing over 1000 entries is skipped with a warning, so such a directory is never collected until it shrinks. `<archive>.move.json` intents are not collected.

An upload left unfinished is reaped by the worker's upload reaper (`repo/upload-reaper.ts`), which
runs at boot and every 15 minutes. It has these passes:

- **Sessions.** A repository, database-dump or bundle upload session idle for 24 hours (`status = 'uploading'`, or `completing` for a complete whose process died, since a live one renews its claim) is moved to `reaping` in one statement. Its `.partial` file is then removed, together with the finished file of a repository or dump session whose complete died after its rename (a bundle's final path belongs to its bundle), and the row turns `cancelled` once every file is gone. A removal that fails, or a death between the claim and the removal, leaves the row `reaping`, and every pass finishes the `reaping` rows of all three tables the same way (`finishReaping`), until a row has failed for 24 hours: it is then parked as `reap_failed` with one error-level log, which every check treats as over like `reaping`; `UPDATE … SET status = 'reaping'` hands it back. A `cancelled` row is deleted 24 hours later.
- **Dumps.** A completed dump is removed 24 hours after the last task that links it ended (completed, failed or cancelled), or 24 hours after its own last update when no task links it. The claim locks the dump row `FOR UPDATE` first, which waits for a task insert still in flight (its foreign key holds the row), then re-checks the task links in a statement that sees that task once it commits, and moves the row to `reaping`. The file goes only after that claim commits, and the row turns `cancelled` once it is gone; a removal that fails, or a death after the claim, leaves it `reaping`, which every pass finishes until the same 24-hour cap parks it as `reap_failed`, and which no task creation or Retry accepts. A cancelled dump row is deleted 24 hours later unless a task still names it, since its foreign key would otherwise null the task's link and a Retry would skip the restore silently. Task creation reads the dump `FOR SHARE` in the transaction that inserts the task, so whichever commits first decides, and a create that loses answers 409. A failed or cancelled task can still be retried within the 24 hours. A Retry after the dump was removed, or parked as `reap_failed`, fails `01c1-restore-database` with a message saying so; it is never skipped silently. A completed dump whose stored path is not its own file is skipped with one warning per row. After `01c1-restore-database` imports a dump it removes the file and marks the row `consumed`; a removal that fails is logged at warn and the file stays, since a `consumed` row keeps its file and no retention rule deletes `consumed` or `complete` rows yet (board T323).
- **Orphan files.** Under `_uploads/<user>/` it removes an exact session partial name older than 24 hours whose session has no row updated in the last 24 hours (a row stamped at the cutoff itself counts as recent, and a parked `reap_failed` session's partial is left alone), so a complete that has just claimed its session keeps its file. It also removes a finished repository archive older than 24 hours unless its repository is still `cloning` (an archive left beside a `ready` repository is the leftover of an unlink that failed after its extract, which `handleExtract` logs; an id no repository carries stays while its owner has a repository cloning), a finished dump file older than 24 hours that no `db_uploads` row names in any status, and an `_uploads/<user>` directory that is empty and older than 24 hours. One sweep computes its cutoff once and every pass uses it. A file that exists but cannot be read counts as present, so a `reaping` row whose file is unreadable stays `reaping`. A removal that keeps failing warns once per path, and again when its error code changes, from a bounded in-process memory; later repeats and every removed file log at debug.
- **Finished metadata.** A `complete` `repo_uploads` or `custom_bundle_uploads` row and a `consumed` `db_uploads` row is deleted 90 days after its `updated_at` (the tables have no finished stamp; completion stamps it), at most 100 rows per table per pass, rechecked at the delete. Kept: a repository upload whose repository is still `cloning` or `error` (a Retry re-reads it), a bundle upload whose bundle is `syncing` or `failed`, and every consumed dump a task row still names (a Retry or a reopened task restores it), so a consumed dump in practice goes with its repository.

Every complete (repository, dump, bundle create and replace) claims its session before touching
its file (`withCompleteClaim`, `api/src/lib/upload-complete-claim.ts`). One UPDATE takes an
`uploading` session or a `completing` claim older than ten minutes, and a live request renews its
stamp every minute. Each later write matches its held stamp, so a takeover refuses the old
request. A failure hands the session back to `uploading`; the partial path stays recorded until
completion. Repository and dump completes may recover their own final file at its expected size.
Repository complete inserts its repository under the session id in the same transaction as its
last write, then queues extraction, so retry creates no second repository.

A bundle replacement uses a unique `source.<uploadId>.<ext>` beside the old archive. Before
renaming, `placeReplacementArchive` (`@haive/shared/bundle-replacement`, Node-only) atomically
writes a durable move intent containing the partial and final relative paths, size, and the held
source descriptor's device and inode as lossless decimal strings. Retry accepts the final only
when its held identity and size match that intent. A vanished partial alone proves nothing, and
another upload's archive is never adopted or overwritten. Promotion takes the bundle row to
`syncing` and points it at that source in a transaction fenced by the held upload. A different
replacement already syncing refuses it. Every Replace ZIP names its mode, chosen in the dialog and
never inferred: `keep_until_success` keeps the previous extracted tree and catalog until the new one
imports and rolls them back on failure, while `remove_first` removes only the extracted tree
(afterward, under the same bundle-then-upload lock order, before enqueue) and gives up that
rollback. Both keep the uploaded archives and the item rows until the replacement commits (see the orphan sweep below). The choice is written beside the
archive (`.replacement.json`) only after the ownership fence, so a retry of the completion keeps it,
and it is cleared after a successful import or a restore. A replacement's warning goes in
`last_replacement_note`, apart from the current tree's extraction report. A retry that
finds its `ingest-zip-<uploadId>` job live or completed finishes the upload without repeating
cleanup; a failed job can be replaced. The upload becomes `complete` only after enqueue, and a
repeated completed request returns the current bundle. The response re-reads the row, including
an ingest failure that arrived before serialization.

Cancel takes only `uploading`, moves it to `reaping`, removes its partial and then marks it
`cancelled`; any refused removal leaves `reaping` for the upload reaper. Repository and dump
cancel also remove their own finished file. A replacement cancel and the reaper share
`discardReplacementArchive`: an unpromoted final is removed only by its recorded inode identity,
while any final the bundle currently names stays. Neither cleanup can follow a link or delete a
different inode at that name. A refused replacement cleanup contributes to the same retry/error
accounting as a refused partial removal: the harmless partial can still go, while the unremoved
archive and intent stay, and the session parks as `reap_failed` after the existing 24-hour window.
Bundle deletion already removes its whole directory, including
retained older archives and move intents.

Git bundle Resync atomically changes a non-syncing row to `syncing` in its new-work admission
transaction. Concurrent requests return 409 and leave the admitted request's job and error alone.
A bounded queue read checks live jobs before the admission transaction opens, so no transaction
waits on Redis, including older anonymous ingest and sync jobs: an enqueue whose acknowledgement was lost can leave a
failed row with a real job. Completeness comes from the public BullMQ range API's atomic ID
snapshot, before hydration: a removed hash must not shrink a capped page into an apparently
complete one. A small snapshot with a missing hash is unknown too, and the five-second deadline
covers the snapshot and hydration together. A live job refuses admission, and a failed or capped queue read holds
with 503 rather than assuming absence. Replacement admission uses the same check, so it cannot
remove a tree an earlier ingest still owns. Under the row lock the admission then compares the
row's generation (`updated_at`, status and archive path, the timestamp compared in JavaScript at
the driver's precision) with the one the queue read was taken against, and refuses with a
retryable 409 when it changed, so a read taken before another import finished or failed never
admits.
A refused enqueue marks only that admission's stamp failed; a lost enqueue that cannot be marked
is covered by the stranded-bundle sweep. The composer carries the API's redacted `lastSyncError`
from both initial and polled summaries and renders it through `MarkdownView` only for `failed`.
The controls wrap on narrow screens, and a stale error on an active or syncing row stays hidden.

The same stalled-task sweep calls `reconcileStrandedCloningRepos` as boot does: only a repository
older than five minutes, with neither a live repo job nor a live root claim, moves from `cloning`
to `error`. The final update repeats status, age and claim checks. It starts no work and changes
no task or runtime state. Both repository and bundle Workers tolerate ten stalls; this policy
belongs to those two queues alone.

**START claims the task, or does nothing.** `claimTaskStart` moves only a `queued` task to
`running` (a stray START leaves a `created` draft alone), pointed at its first step, in one statement fenced on the epoch START read. A START that
finds the task anywhere else — redelivered after the task ran on, a second START a task Retry
queued, a task a repository deletion cancelled — logs and returns, where it used to restart the
task from its first step or revive a cancelled one. The pointer is load-bearing: a task Retry
leaves it on the step that failed, so under a pause the advance START queues for a first step
already `done` read the chain as moved and was dropped, leaving a `running` task nothing drove. A
START that throws before its claim fails the task only while it is still `queued` at
the epoch it read, since a Retry can re-queue the task in between, and fails nothing when it could
not read the task at all; `markTaskFailed` never writes over `cancelled` or `completed` from any
caller. Once START has claimed, its redelivery is
no longer a recovery path: a START that dies after the claim is recovered by the reconcile and the
re-driver above, as any advance is.

**A duplicate delivery re-drives the hand-off the step finished with.** An advance that finds its
row already `done`, while the task still points at that step and round, re-drives the hand-off from
the row (`finishedStepResult`, `step-runner.ts`) rather than as a plain `done`. The apply tail writes
`done` for a fix-loop, restart or revise verdict too, and for a `fixLoopOnError` failure, whose
re-driven diagnosis is the row's `error_message` (with no guidance, see fix-loop.md), so a job that died between that write and its hand-off used
to walk forward past the round its step had asked for. The verdict is recomputed from the stored
output by the one function the tail itself routes with (`finishedRoutingVerdict`), so the two
cannot disagree on precedence. An answered fix-loop gate is finished from its answer instead
(`resolveFixLoopGate`), so a verdict recomputed there cannot replace the person's decision with the
step's own. An answer that reopens the task (continue, or accept with a next step) closes the gate,
records the answer and points the task at its next step in one transaction, under the new-work fence
and then the repository lock when the task had failed, so a refused or overtaken reopen leaves the
gate parked with nothing recorded. The refused answer stays saved on its row. A task Retry, a settle
and a per-step CLI switch that reset a row to `pending` drop it
(`withoutGateAnswer`, `api/src/lib/task-control.ts`), because every write to a `pending` row is
refused: a kept answer was a no-op that the stalled sweep re-drove for good. A Retry and a settle
also set `pause_form_on_retry` on such a row, since a source step that auto-submits its defaults
(`08-phase-5-verify`) would otherwise answer the gate itself with `continue` and run with the
gate's values; the gate parks again and asks. `advanceStep` never auto-submits a form that carries
the gate field, whatever supplies the answer: its defaults, the answers a step reuses from a prior
task, or a pre-answer. Migration `0210_heal_wedged_fix_loop_gate_rows` heals the rows an older
build left wedged (`pending`, unparked, holding a saved answer): it drops the answer and sets the
flag, so the gate asks again, and the dropped answer is not restored. `gate-wedge-heal.test.ts`
runs the file's SQL on Postgres, and `smoke:gate-reoffer` drives the real worker over a Retry, a
never-answered gate, a pre-answered one, a Stop and a healed legacy row. Abort, an accept with no
next step, a dead run list and a continue with no routable target close the row before they act.
A resolver that finds the gate no longer its own (`row_not_owned`: a Retry, Skip or Stop took the
row), the task moved to a newer epoch (`task_moved`), the reopen of a failed task refused
(`revive_refused`, with the refusal's own reason) or no fix target to route to
(`no_routable_target`) applies nothing and logs a `fix-loop gate answer not applied` warning naming
the step, the action and that `reason`. On a task that failed before the
answer was sent, the pickup guard admits the answer onto the `done` row as it would onto the parked
form (`gateAnswerSentAfterFailure`, the task's `completed_at` against the job's own timestamp); a
failure after it was sent, such as a Stop, keeps it out. `advanceStep`'s own `done` short-circuit
is left as it is: the START path that reaches it has no moved-chain check, so a verdict re-driven
there could bump a round.

The re-drive records the step's end-of-step event (`step.done`, `step.skipped`, `step.loop_back` or
`step.revise`) only when the pass it repeats did not. Each of those events carries the row's
`ended_at` as `endedAt`, which names the pass, since a Retry clears it and the rerun sets a new one;
on the re-drive path the event is appended only when no event of that type for that row carries the
same stamp (`appendEventOnce`). A first pass always appends, and a missing stamp never matches.
Before this, a job that died after the event and before the hand-off left two events for one end,
and the statistics count them.

**A step's advances run one at a time.** A continuation leaves the row `waiting_cli` through
apply, and a fan-out's agents each queue an advance as they finish, so two advances of one step can
both reach apply. `holdStepAdvance` (`task-queue.ts`) holds each task, step and round to one advance
at a time in the worker and defers a second with `moveToDelayed` rather than dropping it: the
advance already running may be a barrier check that parks without seeing what the second was
queued for. It replaced a guard that let a second advance skip only while the row read `running`,
which no continuation does any more. An advance that cannot be deferred (no job token, or the move
failed) waits for the holder in this process instead: running beside it is what the hold prevents,
and failing the attempt could lose it, since its three attempts (backed off 5 s, then 10 s) run out
long before a holder's apply does. The hold is
taken outside the job's own catch, since that
catch fails the task, and it is per process, like the queue's single worker. A deferred advance can
then run after the pass it waited behind failed the step, so an advance on a `failed` task is
dropped (`failedTaskRefusesAdvance`): a Retry, a Resume and the allowance auto-resume each set the
task `running` first. An answer submitted to a form still parked is the one exception, since
answering it is what reopens the task; an advance onto that form that carries no answer is dropped
like any other. While the system drains or is in maintenance (`refusesNewWork`, read past the config
cache early in the job and again in the transaction that reopens the task, under the shared new-work
fence a drain's write waits for) that exception closes, as does the fix-loop gate one below: the answer
stays stored on its row and the advance is dropped, so an answer accepted while the task was live
cannot reopen it during a drain. Any error on the early read reads as `'unreadable'`, which `holdsNewWork` counts as held: the advance
throws `MaintenanceStateUnreadable` before it writes, and the allowance auto-resume skips that task
with a warning and goes on to the next armed one; the
read under the fence fails closed: a state it cannot read writes nothing and throws
`MaintenanceStateUnreadable`; that, like a revival that met a busy lock (`RevivalBusy`), moves the
job to delayed for 30 s without failing the task or spending an attempt, and it is retried with the
answer still on its row. A
hold it sees also travels into the write that follows (`taskWriteTarget`, `held`): the task row is
written only while it is not `failed`, so a task that failed after that read is not reopened either. Both
answer routes read the task's status inside their own
transaction, with no row lock (one taken before the step write would cross a Retry's order: step rows
first, the task row last), and admit a failed task through the same fence, 503 while new work is
held. Every admission takes the fence before any repository lock (`withRepositoryTaskLock` admits first, as do the
plan merge and advisory routes), the order the worker's reopen and revival keep: the reverse order deadlocks once a
drain's exclusive request queues between the two. Each route also sets the task `running` itself, in the transaction that writes the answer and
before it queues the advance, so a drain that takes the fence right after counts it live (a
clarification answer rides `task_events` rather than the job besides); it does so only when that read
found the task failed: a task that fails after the read keeps the answer and stays failed until a
Retry.

A Retry's advance waits behind a pass still running, so that pass must not keep what the Retry
reset. A task Retry's START, which only a task that never reached a step still takes, runs its first
step itself rather than through an advance, so it takes that step's hold as well. Every write step-runner makes to a pass's row, and every status the DAG executor and the
merge resolver set on it, and every RAG index banner the onboarding and workflow RAG steps write on their own row, and every merge-state write of the merge resolver (`saveMergeState`, in a dir section or out of one: a section's
epoch check is made once, and a Retry writes its row before the epoch), goes through `updateOwnedStep` (`step-ownership.ts`), which lands only
while the row is still the pass's own, not `pending` (a Retry), `skipped` (a Skip) or `failed` (a
Stop, which fails the row without moving the task's epoch). A note added to a step's warning goes through
`appendStepWarning` (same file): one such write that adds the text once, so a warning another writer added since the
caller read its row is kept. The notes belong to the attempt: a retry note inside it appends the same way (so the
codex fallback and merge notes stay beside "Attempt 2 ..."), and only a new attempt (a Retry, a reset, a per-step CLI
switch) clears the column. A RAG index banner still sets or clears the whole column on purpose: it is a snapshot of
the repository's embedding state, and a healthy run must clear a stale one; it is still an owned write, so a
superseded pass's banner (after a Retry, Stop or Skip) is refused rather than landing on the row that replaced it.
A run a pass records for its row goes
the same way (`insertOwnedRun`, at every insert site in step-runner, the merge resolver and the DAG
executor), and so does a fan-out's reservation: the row is locked while it is still the pass's own,
in the transaction that inserts. The lock comes after the insert, the order a Retry takes them in
(runs and agent rows, then steps), because an insert can wait on a run or an agent row the Retry is
removing; the other order deadlocked the two. A Retry supersedes a step's runs and deletes its agent rows before
it writes the row, and that write waits on the lock, so its reset sweeps a second time once the rows
are written (`resetRowsForRerun`, and `resetStepAndDownstream` worker-side): what a pass recorded
before the Retry took the row is ended there, and a pass after it is refused. A run swept that way
can still be queued by the pass that recorded it, so its cli-exec job starts it only by a
compare-and-swap on `ended_at` and `superseded_at`: the Retry's sandbox kill ran before that job
had a container. That kill runs once, and it can land while a job is still preparing its sandbox, so
the run is read again right before the container is created (`beforeRun`), as soon as it first
prints, when it is certainly running and so either the kill found it or this read sees the
supersede, and every few seconds after (`run-superseded.ts`); a run that reads superseded gets no
sandbox or loses the one it has. A Stop takes the Retry's steps in one transaction
(`stopActiveCliInvocations`): runs, steps, a second sweep of runs, then the task, and the sandboxes
are killed only once it commits. The steps it fails are the `running` and `waiting_cli` ones, a
`pending` one with a park marker (a pause, a runtime slot or a module's schema setup), a `pending`
one that still holds a fix-loop gate's saved answer, the shape a task was left in before a Retry
dropped that answer, and, when the Stop also fails the task, the `pending` row a `running` task that
is not dead points at (its current step and round): a hand-off or a Retry left it for an advance
that has not claimed it or whose job was lost, and a Stop used to answer 0 there. The pointer is
read in a plain statement before the steps are written and never locked, since the task row comes
after the step rows here as in a Retry. A Retry's own settle takes the first three only, since it
would fail the row it has just reset. Any other `pending` row is a step not yet run and stays, and
so does a task whose current row does not exist yet (a hand-off wrote the pointer and the advance
has not created the row): the api cannot create a step row, and failing only the task would send its
Retry down the START replay. What a Stop leaves there, a `failed` row and a `failed` task at the
same epoch, the worker does not touch: an advance for it, at that epoch or an older one, is refused
(`failedTaskRefusesAdvance`), a START claims only a `queued` task, the stalled sweep
takes `running` tasks (and answered forms of waiting ones), and a claim flips only a `pending` row
and refuses a failed task, so the next write to the row is a Retry's reset. No reader sees a run cancelled beside a step still running, and a
Stop that fails leaves every run as it was and kills nothing. When the Stop's own update fails the
task it returns that update's `completedAt` as `failedAt`, and the `task.stopped` event an
administrator's Stop writes carries it: the task page and the task list name a stop as the cause of
a failure only when that stamp equals the task's `completedAt` (`loadTaskStop`, and `loadTaskStops`
for a page of the list in one query, both reading a task's newest 50 stops), since the event is
written after the kill and a Retry that failed in between would otherwise read as the stop's. The same `failedAt` goes to the
settlement a Stop owes: after the commit and the kill, the owner's Stop, an administrator's stop and
an urgent module deactivation each queue one `settle-stopped-task` job (`enqueueStopSettle`),
because a Stop that finds no pass never reaches the pass's own `settleFailedTask`. The wait is
bounded to 2 s and the helper never throws, so a Redis outage never delays or fails the answer. A job the queue never took is not lost: the request event the Stop wrote is re-driven by the stalled sweep (above). The
worker (`handleSettleStoppedTask`) settles only while the task still reads `failed` with a
`completedAt` equal to that `failedAt`: a Retry takes the task out of `failed`, and a later failure
stamps its own instant and settles itself, so either leaves the job nothing to do. The job never
writes the task row, `runTaskJob`'s catch skips its name so a failed settlement is never the task's
failure, and `taskQueueOwed` skips it so a retained job holds no stalled redrive. The allowance auto-resume
(`autoResumeFailedStep`) writes in the same order, its claim on the failed task last, and a claim it
loses takes back every write before it. While new work is refused it does nothing at all, whatever status it read — no write,
no job, no attempt spent — and the next poll resumes the task once the state is normal again. When the state cannot be read
under the fence, or the resume throws anything else, that task stays failed with its watch armed and
the poll goes on to the next armed task (`checkProviderRecovery`).
A repository delete cancels its open tasks the same way, step rows before task rows, and takes what
a Retry takes before that: a plain read that the repository is the caller's own (so a caller who
owns nothing never queues on the key), the repository's task-creation key, then the repository row.
The key is the one a Retry of a task that is not an onboarding or an upgrade takes in `checkRevive`
(those two take it with the repository row), so a Retry that committed first has left a `running`
task, which the delete finds among the open ones and cancels. The delete waits for the key at most
30 s (`boundedLockWait`) and otherwise answers 409 `The repository is busy, try again` with nothing
written. Its repository-row take has a separate 30 s bound, so a relink holding that row cannot
leave the delete waiting without a bound after it obtained the task-creation key. The plan advisory route takes the same key, before its plan node row, since the delete
holds the key and cascades into the node rows, with the same 5 s admission bound. The cancel itself is described after this paragraph. A pass a Stop cut off
mid-apply then releases what the failed task holds (`settleFailedTask`), as its own failure would
have; a Stop that finds no pass queues the same release as a `settle-stopped-task` job (see
`failedAt` above), and when both run a second settlement of one failure is harmless. The cancel poll also stops a
pass whose task moved to a newer epoch. Either way the pass stops there, records no recap and
hands nothing off (`superseded`), and the Retry's pass runs once it lets go. The writes that open a
pass on its `pending` row, claiming it, skipping it, failing a deactivated module's step or failing a
step whose pass threw before it opened the row
(`openPendingStep`, `step-ownership.ts`), land only while it is still `pending`, so a Skip stands. A Retry leaves the row `pending` too, so the same
transaction then reads the task under the job's fence (`taskWriteTarget`: its epoch, and not failed
or finished) FOR SHARE and rolls the flip back when the fence fails. A reset's epoch bump in flight
holds that read until it commits, so no row is ever activated at an epoch a reset has moved past. A
claim that committed before the bump is on the rows the reset reads after it: the api Retry and the
fan-out Resume reset every row still active once they have bumped (`rowsActivatedMeanwhile`, NOWAIT,
since they hold the task row, answering 503 when a pass is mid-write on a row they do not hold already,
see the batch below). Both kill the task's CLI
sandboxes only once that has committed: a refused action then leaves every run alive, and a dying
run's completion finds its invocation already superseded.
The loop Resume, `retry_ai`, Skip and a CLI switch on a failed or parked step take the task back
to their step the same way, through one helper (`moveTaskToStep`), and queue their advance at
the epoch it moved to; a CLI switch on a `pending` row only invalidates its cached form, since
the task has either not reached that row or already queued the advance that claims it. Those four,
the step Retry and the fan-out Resume refuse a `cancelled` or `completed` task with a 409 inside
their transaction, before anything is reset or killed: the task page offers no step action on
either, and a failed task stays fully recoverable. A row that never started (a Stop failed it while
parked) gets its `started_at` stamped there, and its `idle_ms` and the closed gap move to
`carried_idle_ms` (`startIfNeverStarted`): the loop Resume, the fan-out Resume and `retry_ai` all do
it, and `api/test/resume-fold.test.ts` pins the call after each of the three api re-open sites. The
worker's allowance auto-resume does not, since it takes a step that ran.
A task Retry re-runs the step the task stopped on, at its round (`retryTaskAtStep`), rather than
replaying the task from START, which re-derives every stored loop_back and pays each fix round
again. One transaction ends the task's live runs, re-offers a parked row as it was (a form keeps its
schema and answers except a fix-loop gate's, which loses its saved answer and asks again; a runtime
park its detection), resets the failed or live row, its downstream
and any other live row, and moves the task back through `moveTaskToStep` under a bump fenced on
`failed`, so a Cancel that landed first stands (409) and nothing is reset. A `done` or `skipped`
row is left as it is: its advance re-drives the hand-off it finished with. A park's wait is booked
where the worker's `foldPark` books it: to `carried_idle_ms` when the row has no `started_at` (a park
before the run), else to `idle_ms`, which may only hold a wait inside the current run. A Stop keeps that placement.
A Retry's re-offer and the START replay's settle instead close the retained run in that same
transaction: after booking the wait they snapshot `computeStepContribution` at the same database
timestamp, add Work, Idle and user-active time to the corresponding `carried_*` columns, and clear
the live timing. The retained form keeps its prior Work, the unclaimed `pending` interval
contributes nothing, and the worker claim opens a fresh span. They do not use
`computeFoldContribution`, whose discarded-open-run rule reclassifies Work as Idle. Repeating the
action cannot fold an unmarked pending row again; carried values saturate at int4 headroom. A task that never
reached a step still restarts through START, and settles its rows again after its bump, since
answering a parked form revives the task and can open a row in between. That settle locks every
step row of the task, in id order, before it writes (`settleActiveSteps`): a pass that got in before the bump can still
move its row from a form to `running` between two unlocked writes and escape both. The recap goes to the ledger, or to a recap run,
only after the outcome has landed and only while the row still reads `done`: the ledger entry is
inserted by one statement that checks it, and a recap run is queued only once inserted and checked,
since a Retry's reset supersedes only the runs that already exist. That check narrows the window
without closing it: a Retry supersedes a step's runs before it writes the rows, so a recap inserted in
between still reads the row as `done`. The summary write closes it (`writeStepSummary`): it lands only
on the row version it summarized, keyed on the row's `ended_at`, which a Retry nulls and a re-run
rewrites, and only while its own run stands, read under a lock that waits out a supersede in flight.
Its ledger entry follows only a write that landed. The handoff is fenced on the
epoch the pass ran under: `handleResult` does nothing once the task has moved on, and every write it
makes to the task carries that epoch and refuses a task a Stop failed meanwhile, so a Retry or a Stop
landing after that check stands: pointing the task at the next step, parking it on a form, a run or a
fix-loop gate, and completing or failing it, the last two also reaping the task's containers.
A hand-off write that loses its row or the task logs a `step hand-off not applied` line naming the
site and the reason; its level comes from the columns: `info` when a Retry, Skip, Stop, Cancel or dead
mark took it (the row reads `pending`, `skipped` or `failed`, or the task is at another epoch, failed,
cancelled, completed or dead), `warn` for a row or task that no longer exists or for nothing that
explains it.
The allowance watch a failure arms is fenced the same way, and only while the task still reads
`failed`: the teardown before it can outlast a Retry clicked on that failure, which clears the
watch as every other exit from `failed` does. The settle job reads its fence once, at its start,
so a Retry that commits after that read can still meet the teardown in progress, as after a
failure's own settlement. What it removes is rebuilt by the next ensure (task auth volume, terminal
shell); only the shell's state is lost. The hint it leaves on the row (`writeStepHint`) lands
only while the row still reads `failed` and the task is still failed at that epoch, since a reset
clears a hint written before it but not one written after; a finished fan-out's timeout hint lands
only on a row still `done` under the pass's fence, and a login hint only while its run stands.
Answering a fix-loop gate does the same, and closes the gate only while its row is still the pass's
own. So does the advance that parks or starts a step. A pause, a runtime park or a module step's
park for its module's schema setup ([Modules](modules.md)) writes its row and points the task at it
in one transaction (`writeFencedPark`), the row first as a Retry takes rows first, and is dropped whole when the fence no longer holds: a park a Retry overtook leaves the
signature the Retry's own advance reads as a live loop and drops itself behind. A step starts only
while the fence holds. A job revives a failed task only when the task was already failed at pickup,
which the pickup guard allows only for an answer to a form still parked, or to a fix-loop gate
that answer closed before a worker died (above), so a Stop landing after pickup stands; the answer
to a fix-loop gate hands off under the same rule. That holds
for the job's own catch too, which fails the task only at the epoch the job holds it at: the one it
read, or the one a reset the job made itself moved it to, and only from an open status, so a Stop that
failed the task (which moves no epoch) keeps its error and `completed_at`. Such a reset (a fix-loop re-entry, a
revise, boot recovery's) compare-and-swaps that epoch in the write that bumps it, kept last as the
api Retry keeps its own, and a lost swap rolls the whole reset back and hands nothing off. The
hand-off after it points the task at the target only while the task is still at that epoch, and a
fix round's request and `started` event are written in the same transaction: a new round has no row
to reset, so no swap is taken there, and a round a Retry overtook would otherwise count toward the
cap. That transaction first locks the source row while it is still the pass's own
(`lockOwnedStep`), since a Retry writes the steps before it moves the epoch.

**Writers of several step rows of one task take them first, as one batch in id order.** `task_steps.id` is a
random uuid, so two transactions that write overlapping rows in the order their caller lists them, or their
statement scans them, each hold one row and want the other's (40P01). `lockStepRows` (`@haive/database`) is
`select id, task_id ... order by id for no key update`: the lock an UPDATE takes anyway, which conflicts with
every other writer but not with the KEY SHARE a pass's run insert holds on the row (a FOR UPDATE would). The takers are
`resetRowsForRerun` (the whole task), `retryTaskAtStep`, a Stop (`supersedeLiveRuns`), `settleActiveSteps`,
`reofferParkedSteps` (its parked rows), the loop Resume, `retry_ai`, Skip and a CLI switch when a row is left
active (`lockRowsForMove`: the sweep and the DAG reset, then the batch, before the clicked row is written), the cancel core below, and on the worker `resetStepAndDownstream` (its reset rows) and `foldOtherTaskParks` (its
parked rows, in a transaction opened only when a plain read finds one). The CANCEL job's step sweep takes its
open rows through `lockStepRows` in a short transaction of its own, then runs the same UPDATE; no task row is
held there, since `markTaskCancelled` committed before it. The batch goes behind the transaction's sweeps of
runs and agent rows and its DAG reset, since a pass holds a run and then wants its step row, and before its
first step write. The rows stay held until the action commits, so a pass that goes to flip or lock one of them
waits for the action, and a claim then finds the epoch moved past it, instead of activating the row between the
batch and the bump. The batch is never a waiting statement once the task row has been written, since a pass
holding a step row waits for the task row: the Retry, the fan-out Resume and `moveTaskToStep` reset what a pass
activated meanwhile with the rows already held (`rowsActivatedMeanwhile` stays NOWAIT, and `resetRowsForRerun`
takes `rowsHeld` there) and sweep those rows' runs and agent rows without waiting as well (`sweepRunsOf` with
`noWait`: runs FOR NO KEY UPDATE, agent rows FOR UPDATE), since a pass holds a run and then wants its step row
(`writeLoginHint`) and a Stop holds the runs it ended and then wants the step rows, and a FOR UPDATE on a row
held FOR NO KEY UPDATE is an upgrade that conflicts with that run insert. The 503 of that NOWAIT is therefore
left to a row created after the batch that a pass has activated and still writes when the bump lands, to a run
or agent row of such a late row that a pass or a Stop holds, and to an action that took no batch (a fan-out
Resume with nothing to reset, the loop Resume, `retry_ai`, Skip or a CLI switch with no row left active), which
holds only the rows it writes itself; the `step-retry-claim-race` smoke pins both (scenarios 5 and 5b). The
second sweep at the end of the reset still waits: it matches only runs created since the first one. A writer
that folds a row's run into `carried_*` (`resetRowsForRerun`, the per-step provider switch,
`resetStepAndDownstream`, the first park of `writeFencedPark` (`foldRun`), `requeueAbandonedOrphan`) reads the
row after it holds it and folds from that read: its caller's earlier read predates the lock, and a fold or idle
write that landed since would be written over. `requeueAbandonedOrphan` locks the step's open runs before it
reads the row, as a Retry takes them, and ends them only when its guarded flip landed. The contribution comes
from the stored row (`computeFoldContribution`), so adding a stale delta in SQL would only trade the lost update
for a double count; the SQL folds in `cli-park-timing.ts` are single statements and need no read.
`takeLeftOpenKept` (under the creation key and the dir lock; usually one row), `skipRemovedSteps` (one row per
task, at boot) and the `run_seq` backfill (the rounds of one step, at boot) are single statements with no
realistic peer and take no batch. The tiers above the step rows are taken in the same order, runs before agent
rows: the fan-out Resume supersedes its blocking run before it marks the failed agent rows, and the reopened
step form (`holdReopenedForm`) consumes its agent rows before it writes the step row. One exception remains: a
fan-out Resume that also resets downstream or left-active rows still writes the clicked step's agent rows before
the sweep of THOSE rows' runs; it meets a Retry-family action only through a worker reset of the same range or
on a task with no repository (every other Retry-family action takes the repository's creation key first).
Statements that match several runs or agent rows are not batched: each locks its rows in heap order (MEASURED at
96,000 runs: a Seq Scan or Bitmap Heap Scan, rows locked in ctid order), the same order for all of them, so an
id-ordered batch on some of them would be inconsistent with the rest.

**A cancel ends only the step rows it locked.** Every task cancel the api commits goes through one core
(`cancelStillOpen`, `api/src/lib/cancel-task.ts`): the Cancel action, the step `abort` and
`DELETE /repositories/:id/plan/merge` through `cancelTaskIfOpen`, a repository delete through
`cancelOpenTasksForRepo`. It takes every step row of the
tasks, the open ones and the finished, in one id-ordered batch, then the task rows, re-read and locked in id
order, since the wait for the step rows can let a Stop, a completion or another cancel end a task, and it
cancels only the tasks still open. `cancelTaskRow` is handed, per task, the rows that batch locked and ends
only those that are still open. A row created and committed after the batch is not held, and a bulk update
that scanned it would lock it in scan order while a worker's claim of it (`openPendingStep`: the flip, then
the task row FOR SHARE) holds it and waits for the task row the cancel holds (40P01). Such a row is left to
the CANCEL job every cancel queues after its commit: `handleCancelTask` fails every open row of the task, and
the stalled sweep queues a CANCEL that was lost. The Cancel action, the step `abort` and
`DELETE /repositories/:id/plan/merge` each run a Stop (`stopActiveCliInvocations`, `failTask: false`) before
`cancelTaskIfOpen`; the Cancel action and the abort first answer the found status when the route's own read
says the task is `completed` or `cancelled`, so a task that is already over is not stopped. After a cancel
that applied, the three routes clear the task's pause (`clearTaskPause`) before they queue the CANCEL job: a
stale `paused_at` would otherwise outlive the task. Step Retry, Resume and re-run refuse a `cancelled` or
`completed` task (`unendedTask`, `api/src/routes/tasks/steps.ts`). `cancelTaskIfOpen` cancels a task that is neither `completed`
nor `cancelled` (a `failed` one stays cancellable), judged under those locks and not from the status the
route read earlier. A cancel that did not apply answers what it found (the plan merge DELETE answers
`cancelled: false`), writes no event, queues no CANCEL job and clears no pause. The CANCEL job applies the
same rule on its side (`markTaskCancelled`, `worker/src/queues/task-queue.ts`): one
transaction takes the task row FOR NO KEY UPDATE and decides. A `completed` task, or one that no longer
exists, is left as it is: no status write, no event, no step sweep and no teardown, since the `cancelled`
teardown removes the worktree and deletes the env template that a completed task keeps, and the completion
ran its own. A `cancelled` task (the api commits the cancel before it queues the job) keeps its status,
`completed_at` and epoch, but the job still writes its own `task.cancelled` event, ends the step rows opened
after the api's batch and runs the teardown. Any other status, a `failed` task included, is cancelled by the
job: status, `completed_at`, epoch + 1 and the event, in the same transaction. The transaction writes no step
row, so it takes no `lockStepRows` batch and never waits for a step row while it holds the task row (the cycle
with a pass's claim: a step row, then the task row FOR SHARE); the step sweep after it takes its open rows
through `lockStepRows` in a short transaction of its own and holds no task row.

**A form's park marker is stamped once, in the UPDATE that parks it.** The standard runner,
reopened-form path and merge resolver each write `waiting_started_at` with `waiting_form`.
`handleResult` checks row ownership without stamping again, so a submit or clarify that read the
park before the hand-off still matches it, and the hand-off cannot reopen a marker an accepted
answer cleared. The answer routes compare the row's status and original marker under the row lock
(`stillParkedAsRead`); a real re-park is refused with `step_form_not_waiting`. Legacy NULL markers
remain answerable by status. Idle folds use the held current row or a single SQL update, never a
pre-transaction idle value; CLI/provider switches likewise re-read their decision state under lock.

A form submit carries no epoch on purpose, so it cannot be fenced. `isStaleSubmit` drops one that
lands on a form parked after the job was queued, such as a form a `ReopenStepFormError` reopened,
which would otherwise answer the new form with what was typed into the old one.

A latched insight gate (gate 2 while a failed insight check awaits re-approval or inside a gate-3
insight cycle where it is kept for deferred QA findings, gate 3 after that re-approval or after any
gate-3 insight cycle) also binds its answer to the form it was rendered for. The body carries
`stepRowId` and `waitingStartedAt`; unless both equal the row the route found, and that row's
marker is still set (an answered wait has none), the route answers 409 `step_form_stale` and
writes nothing. The latch is read from the latest `insight.check` event and, for both gates, from
the task's `insight.continuation` events, and fails closed: an event it cannot read counts as
latched, and the worker's settled exemption is not repeated, so gate 2 and gate 3 of a task that
ever had a gate-3 insight cycle need the fields. Only these two steps require the fields; every
other step ignores them, so older tabs and automation keep working there. The web sends them on
every step submit and reloads the steps on this code. A client that omits them,
such as an old tab, cannot answer a latched gate until it reloads.

An LLM preparation hook may return `false` when refreshed inputs make the
invocation unnecessary. `resolveLlmPhase` then returns null output to apply
before constructing the prompt or reserving a run. RAG finalization uses this
when a parked PR's current history has no classifiable evidence; its initial
`skipIf` must still allow refresh because reopening can have added queries.

A preparation hook that sees another advance's live bound attempt may throw the
canonical `StepPrepareParkError` (`@haive/shared/step`). The runner verifies a live
singleton invocation for that same step with `hasLiveInvocation` and returns the
existing `superseded` no-handoff outcome. It does not write detection, output,
status or a park marker after the refusal, and it neither inserts nor enqueues.
Returning `waiting_cli` here would let the queue handler change a winner still
`running`, so the refusal uses the no-op path instead. Without a live singleton
invocation it follows normal failure handling with a clear diagnostic; fan-out,
ended, superseded and other-step runs cannot justify it. Ordinary prepare throws
and errors from other hooks retain their existing behavior. This adds no polling
chain or durable state; the winner's completion and the existing recovery sweep
own the next advance. Revert module consumers before removing this host support.

## Task scratch cleanup

`cleanupTaskScratchWorkspace` (`repo/scratch-workspace.ts`) removes only
`<storage>/<userId>/_scratch/<taskId>`, for repository-backed and repo-less tasks alike.
A task must still be completed or cancelled and have no pause marker. Terminal
status decides even when `dead_at` is still set, following `isTaskDead`
(`api/src/lib/task-dead.ts`): a dead task has `dead_at` set and is neither cancelled
nor completed. Cancelling a dead task need not clear that timestamp. Failed,
running, structurally dead and paused tasks keep their recovery files. No repository,
worktree or volume is removed by this reaper.

Every invocation whose `ended_at` and `superseded_at` are both NULL holds scratch,
including queued summaries and scans. A superseded invocation does not hold it,
but a created/running/restarting CLI sandbox still does. Both
`cleanupTaskScratchWorkspace` and boot's missing-task branch use cancellation's
`listCliSandboxesForTask` prerequisite: a failed listing or any
remaining sandbox defers removal. Completion reaps after its fallible bookkeeping;
cancellation keeps its existing teardown prerequisite. Every CLI job, including
failure and finalized redelivery, retries scratch cleanup in its finalizer. Boot's
`sweepOrphanScratchWorkspaces` finishes a reap a worker exit interrupted.

`withTaskScratchWorkspace` serializes materialization, acquisition and reaping per
task in this worker process. The callers that take the section are
`ensureTaskScratchWorkspace`, `cleanupTaskScratchWorkspace`, and the missing-task
branch of `sweepOrphanScratchWorkspaces`. The task-context resolver in
`queues/task-queue.ts` and the two mount resolvers in `queues/cli-exec/resolvers.ts`
acquire scratch through the fenced ensure. That ensure holds it through creation;
the reaper takes it through removal and rechecks task settlement, owner, epoch and
live invocations after waiting and probing Docker. A Retry/continuation cannot
create or acquire the tree while removal holds the section, and can recreate it
after removal releases it. Snapshot materializers and readers must use this same
section for the entire materialization/read, not just path lookup. An invocation
must be recorded before acquiring/mounting scratch; its live row protects the
mount after acquisition returns. A reader without an invocation must retain the
section until it is done. The section is not reentrant: do not call the public
ensure inside it.

The repo-less Editor existence checks in `sandbox/ide-runner.ts` (the
`taskScratchPath` stat) and `api/src/routes/tasks/_helpers.ts` (the
`directoryExists` check) are unfenced read-only stats. They neither materialize
scratch nor hold the section for the Editor's later use. These checks are not
protected readers under the snapshot-reader rule above.

This is an in-process fence under the **one worker per install** assumption (the
fixed worker `container_name`), like the step-advance holds above. Multiple worker
processes or snapshot acquisition in another process would require a shared fence
before being supported; the callback section alone is not a distributed lease.

Boot accepts UUID task-directory names and real directory entries only. An entry
for a task owned by another user never triggers cleanup of that owner's tree.
Missing-task cleanup is a separate boot-only scope: it rechecks absence under the
section, requires the same clean sandbox listing, and removes only the enumerated
user's canonical directory. The clean-listing requirement is stricter than the
base missing-task branch: orphans survive a boot with Docker down until the next
boot, and a remaining live CLI sandbox also retains them. A row appearing before
the absence recheck retains the directory too. Owner directories are opened without
following links, and held while fs-safe walks the scratch path; links in any component cannot
redirect removal into another task's tree.

Rollback restores the narrower repository-task eligibility and accepts leaked
scratch. Keep failed-task retention and the safety fences. No schema change is
needed, and scratch already removed from completed/cancelled tasks cannot be
restored by reverting code.

## Dead tasks

A task is **dead** when its current step requires an uninstalled integration provider, or its data
names a step this install no longer registers: a module was removed, or a step its run list names
went away (`UnresolvedStepError`). A third cause is a registered producer that cannot execute its
pinned output contract or host role policy (`pinned-step-support-unavailable`). An unsupported or
malformed execution-contract pin is another cause (`invalid-execution-contract`): a custom fix
target, a guarded span on a derived, non-static or non-unique run list, a span predicate no
registered step provides, or a span whose first step leads the list. Behind that fence, which
refuses every custom fix target today, `deadTaskResolution` also asks `unsupportedPinnedFixTarget`
(`step-engine/fix-consumer.ts`) about the pinned target: a target absent from the pinned run list,
or registered but not a module step declaring the pinned `fixConsumer` version (or fanning out),
is a cause too; an unregistered target stays an unresolved step (a task with no run-list snapshot
has no list to find it in, so its pin names it) and the task revives once the target registers.
Dead is neither failed nor completed. `markTaskDead`
(`queues/task-queue.ts`) sets `dead_at` and `dead_reason`, keeps the status and the epoch, appends
`task.dead` (`TASK_DEAD_EVENT`) naming the missing ids, supersedes every open run of the task, and
otherwise tears nothing down, so a revive finds the task as it was. The api refuses every advancing
action on a dead task with 409 `task_dead` (`api/src/lib/task-dead.ts`); Cancel stays.

**What marks it.** At boot, `reconcileDeadTasks` (`queues/dead-task-boot.ts`) runs after the
orphaned jobs are handed back and before orphaned steps are recovered; it checks every live task
that has a run-list snapshot or an execution-contract pin and marks one that names a missing step, lacks executable support for a
pinned output contract or host role policy, or carries an unsupported execution-contract pin. At run
time the hand-off marks a task whose current or next step does not resolve. An
`ExecutionContractError` from a worker START or ADVANCE is terminal too: START marks only a
still-queued task at the epoch it read, and ADVANCE uses the held epoch and step-row fence of
`markTaskDeadFromJob`. Both preserve the named reason, append one `task.dead` event and supersede
open runs; their callers kill CLI sandboxes and resync project state after commit. Duplicate jobs
write nothing and the stalled sweep excludes dead tasks. API create and first START refusals still
write no task state, event or job. A task with no snapshot (the dynamic types) and no
execution-contract pin is only ever marked at run time; boot judges one that carries a pin like any
other, naming its pinned fix target beside the steps its last `task.dead` event named.

**What revives it.** Required integrations of the current step are re-resolved as well: a required
`provider-missing` keeps it dead even when every step resolves. The revival owner repeats this check
inside its transaction, including for direct callers. `reviveDeadTask` also rechecks pinned producer
contract, host role policy and execution-contract support inside that transaction; any unsupported
pin, a fix target included, keeps the task dead, with no remap. Execution-contract death uses the same boot revival: a task
whose span predicate was unregistered revives on the first boot that registers it again, and every
boot that does not leaves it dead. A provider restored but deactivated can revive into the integration
park. This uses only resolver state, never dead-reason copy or token refresh (see
[Integrations](integrations.md#dispatch)). The same boot pass revives a dead task once what it was
missing resolves again: a snapshot task when its whole run list does, a snapshot-less one when the
step ids its last `task.dead` event named and its current step do. Judging a snapshot-less task by
its current step alone revived one whose death named a step that was still missing, and its first
job killed it again on every boot. `reviveDeadTask` clears the mark under the epoch
compare-and-swap, records `task.revived`, and enqueues the job the task's status is owed: a start
for a queued task, an advance for a running one, none for a form that is still parked. It first
takes the shared new-work fence and reads the state past the cache: while new work is held, or the
state cannot be read, it writes nothing (the updater starts the target worker in maintenance, so a
revived task would otherwise run during verify and commit). A boot pass that held a revival back,
failed one (a thrown write or a refused enqueue it put back) or could not run at all retries the
revival alone every 30 s (`retryHeldRevivals`), never the boot-only marking or run supersede, until
a pass holds none back and fails none; shutdown stops it. A revival re-enters the same checkout
admission as a Retry whatever status the dead task kept (`running` and `queued` included), excluding
only the task itself from the sibling checks. A revival the repository's own state refuses for now
(its root claim, a live upgrade or onboarding of the repository, or unanswered project-state
conflicts) counts as held and is logged at info with that structural reason; a revival refused
because the repository was deleted is permanent and keeps no timer running. A malformed v3 or derived pin is permanent
too: an epoch-fenced update fails the task, clears the dead marker and records one
`task.failed` event in the same transaction. The pin is retained unchanged. Remaining runs
are superseded after that commit under the new failed epoch, without holding a task-row
lock while taking run locks. Boot and the revival retry sweep also inspect failed tasks
with open runs: a malformed pin retries that cleanup at the failed epoch without another
failure event or epoch bump. Cleanup errors and locked runs keep the retry sweep active
until no open run remains. A queued CLI job refuses a failed task even after its dead
marker was cleared. Settled failures do not keep the revival timer alive. Explicit Retry still cannot repair a
malformed pin or remap its producer.

**Runs.** cli-exec ends a dead task's run instead of starting it (ended, superseded, exit 137): one dispatched after
the mark, or requeued at run time, would otherwise still spend a CLI call. A run already started when the mark lands
is superseded with the rest, and once the mark has committed its caller removes the task's CLI sandboxes
(`killCliSandboxesForTask`, the best-effort kill Stop uses), so the agent stops spending too. The kill touches no merge
state: an open merge stays open, as after Stop. A settled dead task's runtime runner can be preempted on
demand, like a paused one's, instead of waiting for the grace sweep. After a mark lands the pass resyncs the project
state (`resyncAfterTaskEnd`), as every other end of a task does.

**Admission.** A dead task keeps its admission slot (one live onboarding or upgrade per repository): it can revive, and
a second one started beside it would leave two live after the revive. Cancelling it frees the slot. It holds no
checkout, so the checkout-holder checks skip it.

**Display.** A dead task reads as stopped, not running. The Running and "Waiting for slot" filters leave it out, its
clocks and its list row's timing stop at `dead_at`, it shows no slot wait, and an open plan chat or merge panel
refreshes once when it first sees the task dead, then re-checks every 30 s so a revive is noticed.

The unused task-level `PATCH /tasks/:id/cli-provider` route is retired. Change a task's CLI through the step-level picker, which preserves the recovery and ownership fences above. Task creation and summary-provider settings remain supported.

## Repair-evidence retention in the minute sweep

`StalledTaskSweeper.sweep` runs `expireFixTestImages` before any task re-drive or bundle
reconcile. Its own catch logs a warning and allows other work to continue; failures in
later steps cannot starve expiry. Each tick clears bytea from at most 100 live
`fix_test_blobs` rows older than 30 days, using the partial live-created-at index and
stamping `expired_at`, while keeping task/hash/size metadata and immutable event refs.
Admission can expire older content earlier to make room under task/install caps.
The durable manifest survives worker recovery; provisional before bytes are bounded
process memory, so restart/eviction can leave old content unavailable. Display states
that absence and never reconstructs a before file from a later working tree.

## Insight application recovery

A current-generation 08e `insight.auto_round_started` claim or `insight.batch` intent
counts as durable work before any mining
row exists. Boot demotes that running row instead of clearing its approved detect snapshot
and answers. Re-entry uses the same batch identity (source row and rerun generation);
recovery's epoch bump does not create a new batch. Unsent reservations retain their
prompt and deterministic agent id. A linked invocation that ended without a report is
unconfirmed, never an automatic second editor. A parked legacy single-invocation 08e
folds its old reply as unconfirmed rather than starting a mining writer on deployment; a
legacy run that failed or timed out folds the same way, so the step finishes with every item
unconfirmed instead of failing, since its edits may exist.

The first 08e writer provider outage fails the step visibly, preserving the
`provider_unavailable` hint and arming the allowance watch under the existing outage policy.
On manual or automatic Resume, the failed writer folds through apply as unconfirmed without
another writer in that generation, and its retained outage text cannot fail the barrier
again: a Resume fold that completes the step relies on the Resume marker, and when the form
reopens the runner stamps `consumed_at` on the folded rows in the hold transaction. The
fatal-agent scan considers only unconsumed rows; a fresh writer's own outage still fails the
step and arms the allowance watch.
Unfenced reports must be whole, strictly valid JSON objects; fenced reports are also parsed
strictly, with no repair or substitution of earlier examples.

An automatic 08e visit that produced no continuation reopens for outstanding human
decisions in the current unacted inventory. When a writer intent already exists,
`ReopenStepFormError.newAttempt` advances the generation atomically with consuming the old
mining rows and holding the form. The write compares the stored generation with the pass's
expected generation; an overtaking Retry supersedes the hold and rolls consumption back.
Detection uses the new generation, giving a later manual selection a distinct batch while
preserving the automatic outcome and all spent claims. A generation bump is safe only for
steps whose identity is journal-backed, currently 08e. Ordinary reopens preserve their
generation. A manual submit does not reopen again.

Outcome publication is required and replayed from the journal after a lost done write.
A done-row replay keeps the ordinary successor unless its stored outcome carries an insight
revise continuation. Retry clears output and mining
rows and advances generation as before, while retaining journal history and every prior
uncertain attempt. Stop, dead and Cancel refuse the journal's owned task fence. Pause lets
the in-flight batch finish, including all journal stages; it holds the next fresh step and defers a queued invocation at pickup.
Rollback first disables new batches and settles active mining writers with capable workers;
keep journal JSON. Old workers ignore these additive events and cannot reconcile an
active batch safely. No schema migration is needed. The continuation and validation
composition below retain
these source/generation identities and ownership fences.

## Insight revise handoff

The 08e applied outcome computes and persists `{version:1, kind:'insight_revise', batchId,
sourceStepRow, generation, round}` in output and the routing verdict. `round` is the fresh
check round, one greater than the source row. Its done write uses the journal's source-row,
owner, generation and task-epoch fence. Unknown continuation versions are explicitly refused.
A done-row replay reconstructs this verdict without another application.

The handoff validates the pinned verify/review/checkpoint destinations, reads the final tree
outside locks, then resets stale downstream rows, records the required `insight.continuation`
event (payload `continuation` plus physical `targetStepId`), records any validation return
address and moves the pointer in one transaction. Resets take runs before steps and include
the source in the id-ordered step lock batch; the task remains last. Required write failure
rolls back resets, epoch, events and pointer. Duplicate advances cannot claim a second route.
Lost enqueue after commit is recovered by the ordinary pointer-based stalled/boot redrive.

An explicit source Retry advances its generation, invalidating the older route while retaining
all journal history. Downstream Retry keeps the active route and fresh checks; completing
the 08e checkpoint settles it. Recovery's epoch takeover preserves generation and batch.
Stop, Cancel, dead, owner loss and an overtaking epoch refuse publication and handoff. Pause
allows the owned in-flight publication and handoff, holding the next fresh step instead.

Rollback first stops new continuations, then keeps a capable worker until every live v1
continuation settles. Retain the journal and continuation JSON; reverting workers under a
live continuation is unsafe even though this change needs no schema migration.

Checkpoint completion records the exact step row, round and generation in the required
`insight.continuation` handoff payload, in the same owned transaction as the done write.
The owned row's `done` or `skipped` status closes the route; Retry of that row keeps it open,
even after its generation advances. If verification Retry leaves an older checkpoint pending
and then starts a fix round, completing the new round's checkpoint transfers ownership to
that row. The abandoned older row cannot keep the route open. Handoffs without a checkpoint
reference retain the earliest-row rule until a checkpoint publishes its ownership.
A later gate-2 rejection offers new insights through the normal manual form rather than
reopening an earlier settled continuation by creating another pending triage row.
A worker predating checkpoint ownership must not resume a task whose handoff carries that
reference: its earliest-row reader can reopen an abandoned pending row even after the owned
checkpoint settled. Retain capable workers until those tasks cannot resume.

Missing ordered destinations at selection preflight or handoff fail the source step with
explicit Retry guidance, using the ordinary failed-step settlement (which also fails its
task). The writer guard also checks resolved form answers after preset/auto-submit expansion,
including the direct START path, before any editor selection or CLI invocation. A final `ValidationSnapshotError` is handled on that same source step with the
ordinary snapshot message. Both retain a row that Retry can reset; overtaken fences write
nothing. Neither path resets downstream rows or dispatches an editor after refusal.

Each committed insight handoff records one `step.revise` with the continuation marker in
the same transaction as the continuation and pointer. Duplicate delivery records neither
event again; a failed event write rolls the entire handoff back.

Automatic admission refuses stopped, dead, cancelled, completed, foreign-owned,
overtaken and off-pointer work. A pause between detect and claim supersedes that pass
without a claim or incomplete result; resume can classify the same cohort. It also
holds a new automatic writer intent. Stored decisions and spent claims survive Retry.
A claim without a result or an eligible consequential decision without a journal
selection goes to the manual list rather than disappearing as already seen.

Automatic checkpoints publish the same `payload.checkpoint` ownership reference as
manual checkpoints, even when they settle without a writer or continue to another
cohort. The publication shares the owned done transaction, so an abandoned earlier
pending checkpoint cannot reopen a completed automatic route. The resolved-answer
preflight still protects manual presets; automatic writer waves use the same pinned
verification/review/triage validation before reservation or dispatch, through both
START and advance. Skipping and classification-only visits do not require a writer path.

Rollback sets `INSIGHT_AUTO_ACTION_AVAILABLE` false to disable new automatic detection
and claims, including stored opt-ins, and disable new manual opt-ins. Keep capable
workers until active version-1 batches and continuations settle. Retain spent claims
and journal JSON. No schema migration is required; older workers cannot safely consume
active automatic stages or checkpoint ownership references.

## Gate-3 insight recovery

A current-generation gate-3 `insight.batch` intent counts as durable work before done
publication, as an 08e intent does. Boot preserves its approved snapshot and answers.
The same source/generation/batch replays the handoff once; explicit Retry advances the
generation without erasing history. The v1 continuation optionally carries `mode: gate3`
and `stage: apply | checks`; unknown versions are refused. Apply-stage handoff targets
fresh 08e; checks-stage handoff composes with validation and targets fresh verification.
Both retain the atomic event/reset/pointer transaction and lost-enqueue recovery.
Stop/Cancel/dead win; pause lets owned publication/handoff finish and holds fresh work.

Required `insight.check` records preserve failure and new gate-2 approval outside
resettable output. Source Retry cannot erase this task-wide approval requirement.
The precommit guard applies even to an empty selection. Conditional quick gate 2 uses
the latch in both its shouldRun wrapper and fresh pause/provider admission, so a pending
approval cannot accidentally become a dormant skip. A pending approval also forces gate 2
to park rather than replay presets or saved synthetic answers, while retaining the form's
computed defaults. Unanswered persisted schemas are rebuilt without preset overlays.
The submit route records the authenticated owner, rerun generation and explicit decision
in `step.form_submitted` atomically with its answer and cleared park marker. The worker
accepts only that saved answer, with matching row/generation/owner and a submission newer
than the latest failed check (compared at PostgreSQL timestamp precision); legacy unbound
submissions repark. Queue values cannot replace an attested decision. The saved answer
passes the normal persisted-schema validation and the row becomes `running` before apply,
refusing a second owner POST during apply. The required approval-event writer rechecks
this evidence under its existing row and task fences.

Deploy the API and worker together for this change. An old API never sends the required
owner/generation marker, so a latched gate 2 cannot be approved until both are current.
Do not restore an older API while pending approvals can resume. The same attestation now
covers the regenerated gate 3 after human gate-2 re-approval, the first gate 3 after any
gate-3 insight cycle and a gate 2 kept for deferred QA findings inside one: the saved explicit
`commit` or `decision`, owner and rerun generation must match its submit event, newer than the
approval and than the cycle's `insight.continuation` event.
The durable approval and cycle events hold that pass across Retry, Resume and epoch takeover;
synthetic saved values or a job payload repark through the existing approval guard.
Gate-3 batch intents carry a bounded SHA-256 digest plus an incomplete flag; outcomes carry
the unchanged comparison. The continuation's original gate-3 intent remains the baseline
across 08e Retry, so an interrupted writer's unchecked edits cannot become a fresh baseline.
Historical per-file maps are read for compatibility, stripped before publication and
omitted from browser event responses; their old equality cannot authorize a skip.
Older strict journal readers cannot consume those added fields:
keep compatible workers for every resumable task carrying those records, even after
its batch and check shortcut settle. Finishing a batch alone does not make an older
reader compatible, since journal loading reads historical records too.
Report snapshots stay immutable
per source generation and readable after completion.

Rollback stops offering new gate-3 picks and automatic batches, then retains capable
workers until active continuations and pending new gate forms are settled. Retain check
latches, journals, report readers and compatible derived-pin readers for every resumable
task. Reverting an executor underneath that state is unsafe. No schema migration needs
reversal, and spent claims and attempt history are never reset.

## Guard decision persistence

`evaluateGuardDecision` decides a guarded span at its entry; the span-entry hook in the
step machine calls it (see [Span entry](task-types.md#span-entry)). It writes only
`guard_state`. Its pending span-entry decision is committed under the id-ordered
step batch followed by the task's epoch/owner/live-status/pointer fence. The record
uses the entry rerun generation, round, immutable contract/list hash and exact
settled producer row identity; an epoch takeover alone preserves it. Shared
predicates read their earlier decision and producer identity, never newer task-only
DAG state. A failed persistence transaction leaves no decision; a lost reply after
commit replays the stored result without evaluating again. Each transaction sets
LOCAL statement and lock timeouts before the batch; the predicate has a separate
deadline and no usable path, progress writer or host capability. Deadline and
predicate failures roll back and release locks rather than persisting false.
SQL already in flight remains subject to the server-side statement deadline.

The span skip writer commits all pristine members skipped
under the same ordered batch then task fence, with no output or recap. Non-entry
members carry generation-bound guard-skip receipts; duplicate and partial replay
must match the stored entry decision. The writer moves no task pointer and queues
nothing. Its unchanged entry pointer is the recovery anchor for a post-commit
finished-row handoff. Failure before enqueue or acknowledgement loss retries the
same decision without step execution. Skips stamp ended_at and updated_at;
redelivery keeps that pass identity and appends one step.skipped event. Replay
checks exact receipts and empty work fields, excluding terminal timestamps.
The advance caller retries only lost decision and skip writes
and SQLSTATE 55P03/57014/40P01/40001; the hook rethrows them so the queue retries the job.
Permanent guard errors return a separate refused outcome with the reason and no handoff: the
entry step fails with that reason code and Retry decides again. A producer that is not done,
a predicate error, a predicate deadline and a non-boolean answer are all permanent. The hook
materializes all span member rows before the decision/skip lock batch; a missing member refuses
rather than retrying forever. Limits are capped at
2147483647 ms; late predicate writes through an ended handle are refused.
The runner keeps its in-place generation reconciliation:
08e can be a span entry. `holdReopenedForm` consumes mining rows before taking the
ordered step batch and the task owner/epoch/pointer fence, then atomically rebinds
its retained decision and dependent/shared/producer references with the generation
bump and durable form hold. Committed skips and branch results remain unchanged.
Crash rollback and stale-pass refusal prevent duplicate bumps or lost held forms.
No predicate is reevaluated. See Task types for worker-first deployment and rollback.

Explicit upstream reruns (API task/step Retry and worker revise/recheck/fix reset)
clear forward decisions and their skips, including pending entries read after the
ordered batch. They advance affected generations in the same transaction as the
ordinary reset and epoch fence. Newly included rows have their runs and agents
swept under NOWAIT, so a busy writer rolls back the reset rather than crossing
lock tiers. A full START Retry invalidates recorded branches
too. A degraded done fan-out's Resume cascade regenerates downstream producers,
so it invalidates their decisions/skips too. The forward rescan starts at the
clicked producer under the ordered batch even when the initial downstream reset
selection was empty. One boolean both supplies the batch-forcing rescan anchor
and marks that batch held for the retained-row sweep. Guarded done-producer controls
with an empty initial downstream reset set interleave Resume with a Retry-order peer
and a decision writer (step batch before task SHARE), and exercise NOWAIT refusal
beside a pass and Stop holding a retained row's run. They assert no 40P01,
committed-decision invalidation and complete rollback on contention. Only retained
left-active and loop Resume work preserves guards. Recovery keeps guard state and generations and
leaves guard-owned skipped members closed. Park re-offer and START settlement
clear guard_state whenever they advance rerun_generation, preventing stale replay. Stop, BullMQ boot requeue, orphan reconcile, stalled
redrive and dead revival preserve the stored branch; an epoch takeover alone
cannot re-evaluate it. Changed entry, dependency or producer generations still
refuse stale replay. The worker's capability check at START, advance, boot and revival
stays authoritative: a pin it cannot run marks the task dead.
Rollback leaves nullable 0245 guard_state and immutable task pins intact. Retain
capable workers while any guarded task can resume.

Ordinary worker reset locks and reads retain main's exact id sets, including
owned handoff locks without resetting those held-only rows. Guarded pins alone
widen the batch to the target and later rows in its round. Other fix-loop rounds
are never disturbed. The API retains its pre-existing task-wide batch, but reads
only requested ids on ordinary pins and same-round forward held rows on guarded
pins. Ordinary resets omit guard_state from SET and ordinary START adds no full
step-row SELECT. Both reset helpers accept the caller's immutable executionContract
and only project it when the argument is undefined (worker before its transaction,
API on its supplied transaction). Every production caller supplies the loaded pin;
orphan reconcile adds it to the existing joined read. Ordinary resets therefore
add no statement; literal all-table query captures pin the main statement list,
lock predicates, reads and complete SET key sets for null and inert pins.
No reset lock_timeout is added. API resets report extra rows
with their pre-reset statuses, so every caller includes their sandbox cleanup
and audit even if a guard row was claimed after its initial selection. Retained
Resume rows reset after a held batch use NOWAIT run sweeps to avoid reversing
lock tiers.

## No-change cleanup recovery

`12-no-change-cleanup` records `worktree.no_change_cleanup` in a short owned
step/task-fenced transaction before an atomic fs-safe move into a fresh host UUID
under `.haive/no-change-cleanup/`. The event binds setup identity, the proven commit
and the source directory device/inode as decimal strings from bigint stats;
all identity probes and comparisons preserve the exact values, including inode
numbers above 2^53. Non-digit device/inode journal fields refuse parsing. Every pass, including a resumed journal,
takes the owned step row before the task epoch/status fence. Fenced sections hold
those rows across their filesystem and Git writes and use only their transaction
for database writes; Retry/Stop/Cancel wait for a section already in flight.

The clean-tree check runs again after the intent transaction, immediately before
the identity probe and rename. Changes are then checked through the staged tree's
gitfile, with initialized submodules verified recursively using command-local
`--work-tree` paths rather than their now-stale persistent `core.worktree` values.
The equal-depth staging/worktree layouts keep relative submodule gitfiles valid.
Recursive submodule history retention is checked before staging, after journaling
and during staged verification too (see [No-change cleanup](merge-conflicts.md#no-change-cleanup)).
A refused staged check restores the tree without overwriting a replacement
at its original name and rethrows; failed restoration keeps both trees and refuses
recovery while the replacement remains. New journals carry `phase: staging`, and a
successful staged check commits `phase: removing` before the first unlink in a
separate owned section. A crash after rename but before that authorization rechecks
the staged tree, while a partly deleted authorized tree resumes removal without
misreading missing tracked files as new edits. A journal without a phase is unreadable
and refuses. Explicit Retry retains events
even though it clears apply receipts. A changed staging identity or a new source
directory beside the staged one refuses recovery. Removal repairs directory
permissions through fs-safe, as `removeWorktreeDir` does. Both the step and Cancel
pass the journal's expected device/inode to `removeNoFollow`: it opens the leaf
directory without following links through the held parent, compares its held
identity before deleting contents, then removes contents through that descriptor.
A replaced directory or symlink raises `DirectoryIdentityError`
(`EDIRECTORYIDENTITY`) without deleting the replacement. Before every final
name-based `rmdir` attempt, including a permission-repair retry, it checks the leaf
identity again through the held parent. An already absent directory remains a
successful recovery cut. Node exposes no atomic identity-bound `rmdir`, so the
last identity check and that syscall still have a small name-replacement window.
Its worst case is removing one EMPTY directory of the wrong identity: `rmdir`
fails with `ENOTEMPTY` on a non-empty directory and `ENOTDIR` on a symlink.

An old setup's journal no longer blocks once neither its staging directory nor a
same-device/inode source at its recorded path remains. Before staging, a branch tip
that moved is rechecked against the live base and a fresh intent records the current
tip; a moved branch with staging still present refuses. Worktree absence and branch
absence are successful recovery cuts, and an already-complete replay skips ancestry.
With a remaining tree but no branch, the last complete worktree HEAD log entry
supplies the commit; a bounded unreadable/partial log refuses. Index, worktree and
untracked changes are checked against that commit without recreating the branch.
The final branch deletion compares its proven tip and verifies the base in one Git
ref transaction. A changed ref fails retryably. `git worktree prune --expire now`
has no path selector: it clears stale registrations repo-wide, as setup's prune and
`removeWorktreeDir` already do, and removes no other worktree directory.
Another task's prune that lands while the staged tree is being checked can drop this
worktree's registration, since its recorded path no longer exists. The staged check then fails,
the tree is restored with every file and commit intact, and each Retry refuses until the
worktree is registered again by hand. This fails closed; locking the worktree around the move
would add a mutation that interacts with the same prune, so it is not done.

After sandbox teardown is proven, Cancel discards inode-bound staging directories
last in its directory-cleanup block. A refused discard is caught so model unloads
and KB cleanup still run; it is rethrown before `task.cancel_finished`, retaining
the existing redrive. With no cleanup journal this helper adds no task-row read.

The tree checks bound concurrent-edit windows; they do not freeze a writer holding
an open cwd or descriptor. Such a writer can still edit after the final staged
check or during an authorized partial removal. The step does not quiesce live
terminal, IDE or CLI writers. Ignored files are intentionally removed without being
counted as uncommitted work, matching the ordinary cleanup policy.

Rollback first removes the step from definitions admitting new tasks, and retains
a capable worker until every task pin naming it and every interrupted staging
removal is settled. Older workers do not understand staged verification phases and
must not resume an unchecked staged move. Keep the event records. Reverting code cannot restore removed
worktrees; retained Git commits can be checked out again from the base. No migration
is added or reversed.
