# Worker restarts

**A step keeps the status that says what it is waiting on, even while its apply runs.** A
continuation (the advance an ended CLI run queues) re-enters a `waiting_cli` step. For a
form-bearing step it used to re-validate the saved answers and flip the row to `running`. A worker
that died from that point on left a `running` row, which boot reads as a pass that died before
doing anything, so it reset the step: every agent row deleted and the answers cleared. Now a
continuation that finds its answers saved uses them as they are, and the row stays `waiting_cli`.
Values the job carries are ignored there, since a parked step's only source of them is a submit
redelivered after it was applied. A submission, a retry and a first run still flip to `running`.

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
  like the parked ones. Without agent work it is reset and re-run, as a deterministic step always
  was.

**A running task that nothing drives is taken over.** A `running` task whose current step row is
missing, `pending` and not parked, or finished (`done`/`skipped`) with nothing after it, while the
task queue holds no job for it, is re-driven by `redriveStalledTasks` (`queues/stalled-redrive.ts`):
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
START on the queue is no such job (`taskQueueOwed`): it only claims a task still waiting to
start, so one a dead worker left `active` under its 30-minute lock would otherwise hold a claimed
task for that long and then do nothing.

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
locks that row before the task row, the order a Retry takes (the other order deadlocked); a Retry,
Resume or CLI switch whose NOWAIT re-check meets that lock answers 503 and can be sent again. A
`running` task's fence locks only the task row: it reads the row inside the update its epoch guards,
and that update's stamp on the task throttles the next pass. A dead `waiting_user` or `waiting_pr` task revived
with an answered form gets that advance at revival (`jobAfterRevive`).

The same sweep covers the two other jobs that can be lost with nothing to notice. A task left
`queued` past the cutoff with no START on the queue gets one, which the claim makes safe to
duplicate; `created` is left alone, since a deferred-start draft waits there on purpose. Every
route that starts a task moves it from `created` to `queued` before it queues START, after every
write that can fail (`markQueuedForStart`, `api/src/lib/task-start.ts`), under the repository's
task-creation lock, since a queued task holds the checkout and a checkout move holds that lock. The
api waits at most 30 s for it and otherwise answers 409 with nothing created or queued. So a
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
(a pause, the per-task cap and the runtime reserve all hold jobs `delayed`) is left to them. The
lost run never started, so its re-dispatch charges no orphan budget.

A `cancelled` task with a `task.cancelled` event five minutes old and no `task.cancel_finished` (the api commits the cancel before it queues the teardown) gets a CANCEL from the same sweep (`redriveCancelledTasks`), unless one is waiting, active or delayed; a finished or failed one in history does not count, since the finish record is what says the teardown ran, and the teardown is idempotent. Each re-drive is a `task.cancel_redriven` event, and a task stops being re-driven after three (`CANCEL_REDRIVE_MAX`); cancellations older than seven days are not re-driven, since many predate the finish record. A task the re-drive no longer retries but that still holds a merge dir claim is given up instead (`abandonCancelledTeardowns`, started by the same sweep without being awaited, one pass at a time, since its dir locks can wait behind a long merge): capped with its last re-drive older than the cutoff, or with its `task.cancelled` event older than seven days whatever its re-drive count. Giving up keeps the CANCEL teardown's guard: it supersedes the task's runs, kills its cli sandboxes and goes on only when the listing shows none left, or the task keeps its claims for the next pass. Then it reports the merges left open (a failure stops there, with nothing released, and the next pass tries again), writes a `task.cancel_finished` event with `abandoned: true` and its reason (`re-drive cap reached` or `cancelled before the re-drive window`), and only then runs the claim release, the plan-merge discard and the re-sync, each logged and passed over when it fails. The event comes before the release because it is what frees the dir: a cancelled task with that record holds no claim (`liveClaimHolder`), so a pass cut off after it leaves only stale rows that the next claimer takes over. A re-drive whose CANCEL the queue refuses gives its `task.cancel_redriven` event back, so a queue outage never counts toward the cap. A task with a CANCEL waiting, active or delayed is left to it.

The CANCEL teardown releases the task's `merge_dir_claims` rows once `cleanupTaskContainers` has returned and a docker listing (`listCliSandboxesForTask`, null on any failure) shows no cli sandbox of the task left (`releaseTaskMergeClaims`), each one under its dir's advisory lock, so a section the old pass is inside finishes first and a later section of it reads the task as cancelled and refuses. When that listing is not clean the teardown keeps the claims, skips the release, the report of merges left open (`recordLeftOpenMerges`, which otherwise precedes the release), the plan-merge discard and the scratch cleanup (they would remove a dir a fixer may still write), still runs the model unloads and the KB reconcile, then throws: the job fails, no `task.cancel_finished` is written, and the re-drive above repeats the whole idempotent teardown, at most three times, after which the teardown is given up as above and the dir is freed. A cancel that died before then keeps its merge dir held until the re-drive above finishes it; a crashed worker's claim stays held and the boot re-drive of the owning step resumes it ([merge conflicts](merge-conflicts.md)).

A repository delete records its two cleanup jobs (per-project RAG databases, then runners, env images, `haive_repos` files and the repository's finished upload archive, `_uploads/<user>/<repoId>.<ext>`, whose failed removal only warns) as `repo_cleanups` rows inside the delete's own transaction, with no foreign key to the repository that is going. The api queues the jobs after commit, passing each row's id as `cleanupId`, and a queue that refuses them no longer fails the request; the handlers delete their row when they succeed. The same sweep (`redriveRepoCleanups`) queues again any row stamped `last_enqueued_at` ten minutes ago, or never stamped ten minutes after it was written (so it does not race the api's own enqueue), claiming the row on its stamp, counting the attempt only once a queue has taken the job (a refused enqueue puts the stamp back and spends nothing), and carrying it in the job id (`repo-cleanup-<id>-<attempt>`, hyphens, since BullMQ only tolerates a colon in a custom id as a compatibility carve-out for three-part repeat ids), and drops with a warning a row whose job a queue has taken five times (`REPO_CLEANUP_MAX_ATTEMPTS`) so a cleanup that never succeeds is not looped on.

A custom bundle left at `syncing` five minutes after its last update, with no waiting, active, delayed, prioritized or waiting-children job naming it, is marked `failed` with a reason by the same sweep (`reconcileStrandedSyncingBundles`), never re-driven: failed is what re-enables Resync and Replace ZIP. The update is guarded on the status and on that age, since a resync or a replace puts a bundle back at `syncing` with a fresh `updated_at`. The routes need it less often than before: a zip complete keys the bundle and its job (`ingest-zip-<uploadId>`) on the upload, so a repeated or resumed complete finds both instead of making a second bundle, and a job that cannot be queued marks its bundle failed at once (`addBundleJobOrMarkFailed`).

An upload left unfinished is reaped by the worker's upload reaper (`repo/upload-reaper.ts`), which
runs at boot and every 15 minutes. It has these passes:

- **Sessions.** A repository, database-dump or bundle upload session idle for 24 hours (`status = 'uploading'`, or `completing` for a complete whose process died, since a live one renews its claim) is moved to `reaping` in one statement. Its `.partial` file is then removed, together with the finished file of a repository or dump session whose complete died after its rename (a bundle's final path belongs to its bundle), and the row turns `cancelled` once every file is gone. A removal that fails, or a death between the claim and the removal, leaves the row `reaping`, and every pass finishes the `reaping` rows of all three tables the same way (`finishReaping`), until a row has failed for 24 hours: it is then parked as `reap_failed` with one error-level log, which every check treats as over like `reaping`; `UPDATE … SET status = 'reaping'` hands it back. A `cancelled` row is deleted 24 hours later.
- **Dumps.** A completed dump is removed 24 hours after the last task that links it ended (completed, failed or cancelled), or 24 hours after its own last update when no task links it. The claim locks the dump row `FOR UPDATE` first, which waits for a task insert still in flight (its foreign key holds the row), then re-checks the task links in a statement that sees that task once it commits, and moves the row to `reaping`. The file goes only after that claim commits, and the row turns `cancelled` once it is gone; a removal that fails, or a death after the claim, leaves it `reaping`, which every pass finishes until the same 24-hour cap parks it as `reap_failed`, and which no task creation or Retry accepts. A cancelled dump row is deleted 24 hours later unless a task still names it, since its foreign key would otherwise null the task's link and a Retry would skip the restore silently. Task creation reads the dump `FOR SHARE` in the transaction that inserts the task, so whichever commits first decides, and a create that loses answers 409. A failed or cancelled task can still be retried within the 24 hours. A Retry after the dump was removed, or parked as `reap_failed`, fails `01c1-restore-database` with a message saying so; it is never skipped silently.
- **Orphan files.** Under `_uploads/<user>/` it removes an exact session partial name older than 24 hours whose session has no row updated in the last 24 hours (a parked `reap_failed` session's partial is left alone), so a complete that has just claimed its session keeps its file. It also removes a finished repository archive older than 24 hours whose repository is in `error` or gone (a `cloning` or `ready` one keeps it), and an `_uploads/<user>` directory that is empty and older than 24 hours.

Every complete (repository, dump, bundle create and replace) claims its session before it touches the file: one UPDATE moves it from `uploading` to `completing`, stamped with the request's own time (`withCompleteClaim`, `api/src/lib/upload-complete-claim.ts`), or takes over a `completing` claim older than ten minutes. While the complete works it renews that stamp every minute (`COMPLETE_CLAIM_RENEW_MS`), so only a complete whose process died, or that could not reach the database for ten minutes, is taken over. A second complete meanwhile answers 409, and so does a cancel, which takes only an `uploading` session. The row keeps its partial path while `completing`, and every later write of the request matches its own stamp and must land, so a request that lost its claim to a takeover answers 409 and writes nothing more. A write that misses because a renewal moved the stamp meanwhile goes again on the new one. A bundle replace moves its bundle row in the transaction of its last write, so a replace that lost its claim leaves the bundle as it was. The file check accepts the partial at its size, or the final file at its size when an earlier complete died after its rename, which is then not repeated. The last write sets `complete` and the final path; a repository complete inserts its repository, under the session's id, in the same transaction, so a resumed complete never creates a second one, and queues the extraction after it commits. A failure before that write hands the session back to `uploading` unless another complete has taken it over. A complete that loses to the reaper answers 409. Cancel answers 409 for a session that is not uploading and deletes nothing. One it accepts moves to `reaping`, loses the partial and, for a repository or dump, the finished file a complete that failed after its rename left beside it, then turns `cancelled`; a removal that fails leaves it `reaping` for the reaper to finish, and the cancel still answers 200.

**START claims the task, or does nothing.** `claimTaskStart` moves a `created` or `queued` task to
`running`, pointed at its first step, in one statement fenced on the epoch START read. A START that
finds the task anywhere else — redelivered after the task ran on, a second START a task Retry
queued, a task a repository deletion cancelled — logs and returns, where it used to restart the
task from its first step or revive a cancelled one. The pointer is load-bearing: a task Retry
leaves it on the step that failed, so under a pause the advance START queues for a first step
already `done` read the chain as moved and was dropped, leaving a `running` task nothing drove. A
START that throws before its claim fails the task only while it is still `created` or `queued` at
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
and a CLI switch that reset a row to `pending` drop it (`withoutGateAnswer`,
`api/src/lib/task-control.ts`), because every write to a `pending` row is refused: a kept answer was
a no-op that the stalled sweep re-drove for good. Migration `0210_heal_wedged_fix_loop_gate_rows`
heals the rows an older build left that way (`pending`, unparked, holding a saved answer): the answer
is dropped and the flag set, so the gate asks again, and the dropped answer is not restored
(`gate-wedge-heal.test.ts` runs the file's SQL on Postgres). A Retry and a settle also set `pause_form_on_retry`
on such a row, since a source step that auto-submits its defaults (`08-phase-5-verify`) would
otherwise answer the gate itself with `continue` and run with the gate's values; the gate parks
again and asks. Abort, an accept with no next step, a dead run list and a continue
with no routable target close the row before they act. A resolver that finds the gate no longer its
own (`row_not_owned`: a Retry, Skip or Stop took the row), the task moved to a newer epoch
(`task_moved`), the reopen of a failed task refused (`revive_refused`, with the refusal's own
reason) or no fix target to route to (`no_routable_target`) applies nothing and logs a
`fix-loop gate answer not applied` warning naming the step, the action and that `reason`. On a task that failed before the
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
and failing the attempt could lose it, since a continuation is queued with no retries. The hold is
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
cannot reopen it during a drain. The early read fails open, since it only decides whether to try; the
read under the fence fails closed: a state it cannot read writes nothing and throws
`MaintenanceStateUnreadable`, so the job fails and is retried with the answer still on its row. A
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
merge resolver set on it, and every merge-state write of the merge resolver (`saveMergeState`, in a dir section or out of one: a section's
epoch check is made once, and a Retry writes its row before the epoch), goes through `updateOwnedStep` (`step-ownership.ts`), which lands only
while the row is still the pass's own, not `pending` (a Retry), `skipped` (a Skip) or `failed` (a
Stop, which fails the row without moving the task's epoch). A run a pass records for its row goes
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
(`failedTaskRefusesAdvance`), a START claims only a `created` or `queued` task, the stalled sweep
takes `running` tasks (and answered forms of waiting ones), and a claim flips only a `pending` row
and refuses a failed task, so the next write to the row is a Retry's reset. No reader sees a run cancelled beside a step still running, and a
Stop that fails leaves every run as it was and kills nothing. When the Stop's own update fails the
task it returns that update's `completedAt` as `failedAt`, and the `task.stopped` event an
administrator's Stop writes carries it: the task page and the task list name a stop as the cause of
a failure only when that stamp equals the task's `completedAt` (`loadTaskStop`, and `loadTaskStops`
for a page of the list in one query, both reading a task's newest 50 stops), since the event is
written after the kill and a Retry that failed in between would otherwise read as the stop's. The allowance auto-resume
(`autoResumeFailedStep`) writes in the same order, its claim on the failed task last, and a claim it
loses takes back every write before it. While new work is refused it does nothing at all, whatever status it read — no write,
no job, no attempt spent — and the next poll resumes the task once the state is normal again. When the state cannot be read
under the fence, or the resume throws anything else, that task stays failed with its watch armed and
the poll goes on to the next armed task (`checkProviderRecovery`). A repository delete cancels its open tasks the same way:
it locks their open step rows (by id) before it writes any task row (`cancelOpenTasksForRepo`), since
taking the task rows first deadlocked it with a step Retry or a worker's step claim; the wait for those
rows can let a Stop or a completion end a task, so it then re-reads and locks the task rows and cancels
only those still open. A pass a Stop cut off
mid-apply then releases what the failed task holds (`settleFailedTask`), as its own failure would
have. The cancel poll also stops a
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
since they hold the task row, answering 503 when a pass is mid-write). Both kill the task's CLI
sandboxes only once that has committed: a refused action then leaves every run alive, and a dying
run's completion finds its invocation already superseded.
The loop Resume, `retry_ai`, Skip and a CLI switch on a failed or parked step take the task back
to their step the same way, through one helper (`moveTaskToStep`), and queue their advance at
the epoch it moved to; a CLI switch on a `pending` row only invalidates its cached form, since
the task has either not reached that row or already queued the advance that claims it. Those four,
the step Retry and the fan-out Resume refuse a `cancelled` or `completed` task with a 409 inside
their transaction, before anything is reset or killed: the task page offers no step action on
either, and a failed task stays fully recoverable.
A task Retry re-runs the step the task stopped on, at its round (`retryTaskAtStep`), rather than
replaying the task from START, which re-derives every stored loop_back and pays each fix round
again. One transaction ends the task's live runs, re-offers a parked row as it was (a form keeps its
schema and answers except a fix-loop gate's, which loses its saved answer and asks again; a runtime
park its detection), resets the failed or live row, its downstream
and any other live row, and moves the task back through `moveTaskToStep` under a bump fenced on
`failed`, so a Cancel that landed first stands (409) and nothing is reset. A `done` or `skipped`
row is left as it is: its advance re-drives the hand-off it finished with. A task that never
reached a step still restarts through START, and settles its rows again after its bump, since
answering a parked form revives the task and can open a row in between. That settle locks every
active row before it writes (`settleActiveSteps`): a pass that got in before the bump can still
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
The allowance watch a failure arms is fenced the same way, and only while the task still reads
`failed`: the teardown before it can outlast a Retry clicked on that failure, which clears the
watch as every other exit from `failed` does. The hint it leaves on the row (`writeStepHint`) lands
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

A form submit carries no epoch on purpose, so it cannot be fenced. `isStaleSubmit` drops one that
lands on a form parked after the job was queued, such as a form a `ReopenStepFormError` reopened,
which would otherwise answer the new form with what was typed into the old one.

An LLM preparation hook may return `false` when refreshed inputs make the
invocation unnecessary. `resolveLlmPhase` then returns null output to apply
before constructing the prompt or reserving a run. RAG finalization uses this
when a parked PR's current history has no classifiable evidence; its initial
`skipIf` must still allow refresh because reopening can have added queries.

## Dead tasks

A task is **dead** when its data names a step this install no longer registers: a module was removed, or a step its
run list names went away (`UnresolvedStepError`). Dead is neither failed nor completed. `markTaskDead`
(`queues/task-queue.ts`) sets `dead_at` and `dead_reason`, keeps the status and the epoch, appends `task.dead`
(`TASK_DEAD_EVENT`) naming the missing ids, supersedes every open run of the task, and otherwise tears nothing down, so
a revive finds the task as it was. The api refuses every advancing action on a dead task with 409 `task_dead`
(`api/src/lib/task-dead.ts`); Cancel stays.

**What marks it.** At boot, `reconcileDeadTasks` (`queues/dead-task-boot.ts`) runs after the orphaned jobs are handed
back and before orphaned steps are recovered; it checks every live task that has a run-list snapshot and marks one that
names a missing step. At run time the hand-off marks a task whose current or next step does not resolve. A task with no
snapshot (the dynamic types) is only ever marked at run time.

**What revives it.** The same boot pass revives a dead task once what it was missing resolves again: a snapshot task
when its whole run list does, a snapshot-less one when the step ids its last `task.dead` event named and its current
step do. Judging a snapshot-less task by its current step alone revived one whose death named a step that was still
missing, and its first job killed it again on every boot. `reviveDeadTask` clears the mark under the epoch
compare-and-swap, records `task.revived`, and enqueues the job the task's status is owed: a start for a queued task,
an advance for a running one, none for a form that is still parked. It first takes the shared new-work fence and
reads the state past the cache: while new work is held, or the state cannot be read, it writes nothing (the updater
starts the target worker in maintenance, so a revived task would otherwise run during verify and commit). A boot pass
that held a revival back, failed one (a thrown write or a refused enqueue it put back) or could not run at all retries
the revival alone every 30 s (`retryHeldRevivals`), never the boot-only marking or run supersede, until a pass holds
none back and fails none; shutdown stops it.

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
