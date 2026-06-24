import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

// Reset a step + its downstream back to `pending` so the worker re-runs the step from
// detect. Used by the `revise` route (handleResult): a review step asks to re-run an
// earlier generator (e.g. 03c reject → re-mine 03b). Mirrors the API retry reset
// (packages/api/src/routes/tasks/steps.ts) but lives worker-side so the queue can drive
// it without an HTTP round-trip. The two are intentional duplicates — keep them in sync.

/** Reset `targetStepId` and every non-pending downstream row (same round) to `pending`,
 *  superseding their open cli_invocations and dropping their agent minings. Deliberately
 *  does NOT touch task_events: append-only channels the target reads to revise (e.g. the
 *  biz-req rejection feedback) must survive the reset, exactly as across an API retry.
 *  Scoped to `round` so a concurrent fix-loop round's rows are never disturbed. Bumps the
 *  task's orchestration epoch (like the API retry) so stale advance-step jobs no-op.
 *  Returns the downstream-reset count + the new epoch, or null when no target row exists. */
export async function resetStepAndDownstream(
  db: Database,
  taskId: string,
  targetStepId: string,
  round: number,
): Promise<{ downstreamReset: number; newEpoch: number } | null> {
  const targetRows = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, targetStepId),
        eq(schema.taskSteps.round, round),
      ),
    )
    .limit(1);
  const target = targetRows[0];
  if (!target) return null;

  const downstream = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.round, round),
        gt(schema.taskSteps.stepIndex, target.stepIndex),
      ),
    );
  const downstreamToReset = downstream.filter((r) => r.status !== 'pending').map((r) => r.id);
  const allStepIds = [target.id, ...downstreamToReset];

  let newEpoch = 0;
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(schema.cliInvocations)
      .set({ supersededAt: now })
      .where(
        and(
          inArray(schema.cliInvocations.taskStepId, allStepIds),
          isNull(schema.cliInvocations.supersededAt),
        ),
      );
    await tx
      .delete(schema.taskStepAgentMinings)
      .where(inArray(schema.taskStepAgentMinings.taskStepId, allStepIds));
    // Clearing formSchema is essential: the runner only re-renders the form when the
    // persisted schema is null. formValues is cleared so the regenerated form re-decides.
    await tx
      .update(schema.taskSteps)
      .set({
        status: 'pending',
        detectOutput: null,
        formSchema: null,
        formValues: null,
        output: null,
        iterations: [],
        iterationCount: 0,
        statusMessage: null,
        errorMessage: null,
        errorHint: null,
        startedAt: null,
        endedAt: null,
        idleMs: 0,
        waitingStartedAt: null,
        userActiveMs: 0,
        updatedAt: now,
      })
      .where(inArray(schema.taskSteps.id, allStepIds));
    // Bump the task's orchestration epoch so any advance-step job queued under the
    // prior epoch (a stale/duplicate job) is skipped by handleAdvanceStep — the
    // worker-side equivalent of the API retry's epoch bump.
    const bumped = await tx
      .update(schema.tasks)
      .set({ orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`, updatedAt: now })
      .where(eq(schema.tasks.id, taskId))
      .returning({ epoch: schema.tasks.orchestrationEpoch });
    newEpoch = bumped[0]?.epoch ?? 0;
  });

  return { downstreamReset: downstreamToReset.length, newEpoch };
}
