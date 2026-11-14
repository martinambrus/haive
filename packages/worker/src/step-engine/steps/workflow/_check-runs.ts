import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CheckOutcome, CheckSlot } from '@haive/database/schema';
import type { StepContext } from '../../step-definition.js';

type SettledOutcome = Exclude<CheckOutcome, 'running' | 'interrupted'>;

/** Like step 11's learningOutcomeId (#1168), identity survives recovery's epoch
 * bump and changes on explicit Retry. The loop iteration identifies 08b's passes.
 * Keep the step-row id inside the identity even after its FK is set null. */
export async function recordCheckRun<T>(
  ctx: StepContext,
  check: { stepId: string; slot: CheckSlot; iteration: number },
  execute: () => Promise<T>,
  classify: (result: T) => SettledOutcome,
  replay: (outcome: SettledOutcome) => T,
): Promise<T> {
  const t = schema.taskCheckRuns;
  const attemptId = JSON.stringify([
    ctx.taskStepId,
    ctx.round ?? 0,
    ctx.rerunGeneration ?? 0,
    check.iteration,
  ]);
  let id: string | undefined;
  let existing: { outcome: CheckOutcome } | undefined;
  try {
    const inserted = await ctx.db
      .insert(t)
      .values({
        taskId: ctx.taskId,
        taskStepId: ctx.taskStepId,
        stepId: check.stepId,
        slot: check.slot,
        attemptId,
        outcome: 'running',
        startedAt: new Date(),
      })
      .onConflictDoNothing({ target: [t.taskId, t.stepId, t.slot, t.attemptId] })
      .returning({ id: t.id });
    id = inserted[0]?.id;
    if (!id) {
      [existing] = await ctx.db
        .select({ outcome: t.outcome })
        .from(t)
        .where(
          and(
            eq(t.taskId, ctx.taskId),
            eq(t.stepId, check.stepId),
            eq(t.slot, check.slot),
            eq(t.attemptId, attemptId),
          ),
        );
    }
  } catch (err) {
    ctx.logger.warn({ err }, 'check run insert/read failed (non-fatal)');
  }
  if (existing) {
    if (existing.outcome === 'running' || existing.outcome === 'interrupted') {
      throw new Error(
        `The recorded ${check.slot} check is incomplete. Use Retry to start a new attempt.`,
      );
    }
    return replay(existing.outcome);
  }
  let outcome: CheckOutcome = 'interrupted';
  try {
    const result = await execute();
    outcome = classify(result);
    return result;
  } finally {
    if (id) {
      try {
        await ctx.db.update(t).set({ outcome, endedAt: new Date() }).where(eq(t.id, id));
      } catch (err) {
        ctx.logger.warn({ err }, 'check run finalization failed (non-fatal)');
      }
    }
  }
}
