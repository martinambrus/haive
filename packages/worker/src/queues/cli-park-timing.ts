import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

// waiting_cli park accounting. A step in `waiting_cli` is normally the CLI actively running
// = real work, so its span bills as work. But when the invocation(s) end and the step does
// NOT advance — a rate-limit/allowance park, a lost advance job, or the initial queue wait
// before the first invocation runs — that gap is idle, not work. We record it the same way
// waiting_form does: stamp `waiting_started_at` while parked, fold the elapsed span into
// `idle_ms` when work resumes. computeTaskTiming (@haive/shared) then excludes it (it counts
// a live open wait as idle for waiting_cli exactly when waiting_started_at is set).
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
 *  parallel starters no-op. greatest(0, …) guards against clock skew. Call when an invocation
 *  begins running. */
export async function foldCliParkOnResume(db: Database, stepId: string): Promise<void> {
  await db
    .update(schema.taskSteps)
    .set({
      idleMs: sql`${schema.taskSteps.idleMs} + greatest(0, floor(extract(epoch from (now() - ${schema.taskSteps.waitingStartedAt})) * 1000))::int`,
      waitingStartedAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(schema.taskSteps.id, stepId), sql`${schema.taskSteps.waitingStartedAt} IS NOT NULL`),
    );
}
