import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
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
 *  Scoped to `round` so a concurrent fix-loop round's rows are never disturbed. Returns
 *  the downstream-reset count, or null when no target row exists for that round. */
export async function resetStepAndDownstream(
  db: Database,
  taskId: string,
  targetStepId: string,
  round: number,
): Promise<{ downstreamReset: number } | null> {
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
  });

  return { downstreamReset: downstreamToReset.length };
}
