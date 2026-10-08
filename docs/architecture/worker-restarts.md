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

The same sweep covers the two other jobs that can be lost with nothing to notice. A task left
`queued` past the cutoff with no START on the queue gets one, which the claim makes safe to
duplicate; `created` is left alone, since a deferred-start draft waits there on purpose. Every
route that starts a task moves it from `created` to `queued` before it queues START, after every
write that can fail (`markQueuedForStart`, `api/src/lib/task-start.ts`), so a START that was lost
or could not be queued is the sweep's to give, and the route answers as though it had been
queued. A task whose creation failed partway stays `created`, where nothing starts it. And a `waiting_cli`
current step with a run recorded before the cutoff that no cli-exec job owes, no run of its own
running and no task-queue job, is recovered exactly as boot recovers a parked step
(`recoverParkedStep`), bounded by `bornBefore`: only runs started or recorded before the cutoff are
ended, since a live worker may be starting younger ones. A step whose old runs all still have a job
(a pause, the per-task cap and the runtime reserve all hold jobs `delayed`) is left to them. The
lost run never started, so its re-dispatch charges no orphan budget.

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
(`resolveFixLoopGate`): the gate writes its row `done` before it acts, so a verdict recomputed
there would replace the person's decision with the step's own. On a task that failed before the
answer was sent, the pickup guard admits the answer onto the `done` row as it would onto the parked
form (`gateAnswerSentAfterFailure`, the task's `completed_at` against the job's own timestamp); a
failure after it was sent, such as a Stop, keeps it out. `advanceStep`'s own `done` short-circuit
is left as it is: the START path that reaches it has no moved-chain check, so a verdict re-driven
there could bump a round.

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
like any other. A clarification answer is one of those, since it rides `task_events` rather than the
job, so its route sets a failed task `running` itself before it queues the advance.

A Retry's advance waits behind a pass still running, so that pass must not keep what the Retry
reset. A task Retry's START, which only a task that never reached a step still takes, runs its first
step itself rather than through an advance, so it takes that step's hold as well. Every write step-runner makes to a pass's row, and every status the DAG executor and the
merge resolver set on it, goes through `updateOwnedStep` (`step-ownership.ts`), which lands only
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
are killed only once it commits. No reader sees a run cancelled beside a step still running, and a
Stop that fails leaves every run as it was and kills nothing. The allowance auto-resume
(`autoResumeFailedStep`) writes in the same order, its claim on the failed task last, and a claim it
loses takes back every write before it. A pass a Stop cut off
mid-apply then releases what the failed task holds (`settleFailedTask`), as its own failure would
have. The cancel poll also stops a
pass whose task moved to a newer epoch. Either way the pass stops there, records no recap and
hands nothing off (`superseded`), and the Retry's pass runs once it lets go. The two writes that open
a pass on its `pending` row, claiming or skipping it (`openPendingStep`, `step-ownership.ts`), land
only while it is still `pending`, so a Skip stands. A Retry leaves the row `pending` too, so the same
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
schema and answers, a runtime park its detection), resets the failed or live row, its downstream
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
own. So does the advance that parks or starts a step. A pause or runtime park writes its row and
points the task at it in one transaction (`writeFencedPark`), the row first as a Retry takes rows
first, and is dropped whole when the fence no longer holds: a park a Retry overtook leaves the
signature the Retry's own advance reads as a live loop and drops itself behind. A step starts only
while the fence holds. A job revives a failed task only when the task was already failed at pickup,
which the pickup guard allows only for an answer to a form still parked, or to a fix-loop gate
that answer closed before a worker died (above), so a Stop landing after pickup stands; the answer
to a fix-loop gate hands off under the same rule. That holds
for the job's own catch too, which fails the task only at the epoch the job holds it at: the one it
read, or the one a reset the job made itself moved it to. Such a reset (a fix-loop re-entry, a
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
