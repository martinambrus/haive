import { and, eq, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

// waiting_cli park accounting. A step in `waiting_cli` is normally the CLI actively running
// = real work, so its span bills as work. But when the invocation(s) end and the step does
// NOT advance — a rate-limit/allowance park, a lost advance job, or the initial queue wait
// before the first invocation runs — that gap is idle, not work. We record it the same way
// waiting_form does: stamp `waiting_started_at` while parked, fold the elapsed span into
// `idle_ms` when work resumes. computeTaskTiming (@haive/shared) then excludes it (it counts
// a live open wait as idle for waiting_cli exactly when waiting_started_at is set).
//
// The runtime-slot admission park (task-queue.ts) uses the same marker on a `pending` row —
// it stamps waiting_started_at in its own park UPDATE and foldCliParkOnResume below closes
// it when the step finally runs. `pending` + a non-null marker is therefore the structural
// signature of that park (every other pending writer nulls the marker), which is what
// deriveSlotWait keys the "queued for a runtime slot" badge on.
//
// Invariant: for a waiting_cli step, `waiting_started_at` is non-null iff no invocation is
// currently running. Both writes below are single atomic UPDATEs whose WHERE clause enforces
// the invariant, so concurrent invocation start/end and the transition write can interleave
// in any order without corrupting it (last writer that satisfies the predicate wins; the
// rest no-op).

/** Park begins: stamp `waiting_started_at = now()` for a waiting_cli step that has NO
 *  invocation running. Guarded (status, null-marker, and no-running-invocation) so it is a
 *  no-op while the CLI is active or the marker is already set. Call at the waiting_cli
 *  transition (initial/queue wait) and after an invocation ends (post-wave park). */
export async function markCliParkBegin(db: Database, stepId: string): Promise<void> {
  await db
    .update(schema.taskSteps)
    .set({ waitingStartedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(schema.taskSteps.id, stepId),
        eq(schema.taskSteps.status, 'waiting_cli'),
        isNull(schema.taskSteps.waitingStartedAt),
        sql`NOT EXISTS (SELECT 1 FROM ${schema.cliInvocations}
              WHERE ${schema.cliInvocations.taskStepId} = ${stepId}
                AND ${schema.cliInvocations.startedAt} IS NOT NULL
                AND ${schema.cliInvocations.endedAt} IS NULL
                AND ${schema.cliInvocations.supersededAt} IS NULL)`,
      ),
    );
}

/** Park ends: fold `now() - waiting_started_at` into `idle_ms` and clear the marker. Guarded
 *  on the marker being set, so the first invocation to start running folds the wait and any
 *  parallel starters no-op. greatest(0, …) guards against clock skew. Call when work resumes:
 *  when an invocation begins running (agent park) and at the pending -> running flip
 *  (runtime-slot park, step-runner.ts). Status-agnostic by design — the marker alone says a
 *  park is open, so both parks close through this one statement. */
export async function foldCliParkOnResume(db: Database, stepId: string): Promise<void> {
  await foldPark(db, eq(schema.taskSteps.id, stepId));
}

/** Park ABANDONED: same fold, keyed on (task, step, round) instead of a row id. A runtime-slot
 *  park lives on a delayed advance job; when that advance is skipped because another step of the
 *  task became active, the poll chain ENDS (handleAdvanceStep returns without re-enqueueing) and
 *  the step is no longer waiting for a slot — it is blocked behind the active step. Closing the
 *  marker there is what stops it ticking idle in parallel with the step that is really working
 *  (a dead loop cannot fold its own park), and stops deriveSlotWait reading a task that has
 *  moved on as still queued. */
export async function foldAbandonedPark(
  db: Database,
  taskId: string,
  stepId: string,
  round: number,
): Promise<void> {
  await foldPark(
    db,
    and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, stepId),
      eq(schema.taskSteps.round, round),
    )!,
  );
}

/** The one fold statement both callers share: credit the elapsed park to idle_ms, clear the
 *  marker, and no-op when no marker is set. */
async function foldPark(db: Database, target: SQL | SQLWrapper): Promise<void> {
  await db
    .update(schema.taskSteps)
    .set({
      idleMs: sql`${schema.taskSteps.idleMs} + greatest(0, floor(extract(epoch from (now() - ${schema.taskSteps.waitingStartedAt})) * 1000))::int`,
      waitingStartedAt: null,
      updatedAt: sql`now()`,
    })
    .where(and(target, sql`${schema.taskSteps.waitingStartedAt} IS NOT NULL`));
}

/** Boot reconcile only. A worker that died mid-park leaves a waiting_cli step in one of two
 *  broken states, and BOTH bill the whole downtime as WORK:
 *    (a) no marker — it died while an invocation was running, so the invariant above was never
 *        re-established; computeStepContribution sees ended=null + waitStart=null and counts
 *        start->now as work (observed: 150h of "work" for a 6-day outage with 0.16h of real
 *        CLI runtime).
 *    (b) a live marker — correct in the live view, but openWait only counts while ended_at is
 *        null, so whatever ends the step after the restart silently reclassifies the whole
 *        park back to work.
 *
 *  Fix both by making the gap DURABLE: fold it into idle_ms (permanent — unlike an open marker
 *  it survives any later ended_at stamp) and restamp the marker at now() so the forward wait
 *  keeps accruing and foldCliParkOnResume closes it normally. For case (b) this is
 *  arithmetically neutral at the instant it runs (idle_ms gains exactly what openWait loses);
 *  it only makes the number stick. Note a backdated marker is NOT sufficient: reconcile's very
 *  next act is enqueueAdvance, which drives the step to done/failed and stamps ended_at, at
 *  which point openWait stops counting and the whole gap reverts to work.
 *
 *  Gap start = the marker when set, else the newest invocation START — which is exactly where
 *  foldCliParkOnResume last folded, so idle_ms and this fold abut with no gap and no overlap —
 *  else the step's own started_at (nothing ever ran). Deliberately NOT max(ended_at): the
 *  reconcile stamps ended_at=now() on the orphans it just closed, so that would read as "now"
 *  and silently no-op; and anchoring at an earlier ended_at would double-count the
 *  [last end, next start] span idle_ms already holds. The [start, crash] sliver of real work is
 *  booked as idle, which under-reports work rather than inventing it.
 *
 *  least() clamps to int4 headroom because idle_ms is an integer column: an outage past ~24.8
 *  days would otherwise raise "integer out of range", the caller's per-step try/catch would
 *  swallow it, enqueueAdvance would never run, and the task would wedge forever.
 *
 *  Call AFTER the step's orphaned invocations are marked ended (the NOT EXISTS guard is what
 *  proves no CLI is live) and BEFORE enqueueAdvance (so the re-driven step cannot start an
 *  invocation into an unmarked park). Unlike markCliParkBegin this does NOT require the marker
 *  to be null — case (b) is precisely the already-marked one — so the guard set is otherwise
 *  identical and the statement leaves the marker non-null, preserving the invariant on exit. */
export async function foldOrphanedCliParkOnBoot(db: Database, stepId: string): Promise<void> {
  const gapStart = sql`coalesce(
    ${schema.taskSteps.waitingStartedAt},
    greatest(${schema.taskSteps.startedAt},
      (SELECT max(${schema.cliInvocations.startedAt}) FROM ${schema.cliInvocations}
        WHERE ${schema.cliInvocations.taskStepId} = ${stepId}
          AND ${schema.cliInvocations.supersededAt} IS NULL)),
    now())`;
  await db
    .update(schema.taskSteps)
    .set({
      idleMs: sql`${schema.taskSteps.idleMs} + least(2147483647 - ${schema.taskSteps.idleMs},
        greatest(0, floor(extract(epoch from (now() - ${gapStart})) * 1000)))::int`,
      waitingStartedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.taskSteps.id, stepId),
        eq(schema.taskSteps.status, 'waiting_cli'),
        sql`NOT EXISTS (SELECT 1 FROM ${schema.cliInvocations}
              WHERE ${schema.cliInvocations.taskStepId} = ${stepId}
                AND ${schema.cliInvocations.startedAt} IS NOT NULL
                AND ${schema.cliInvocations.endedAt} IS NULL
                AND ${schema.cliInvocations.supersededAt} IS NULL)`,
      ),
    );
}
