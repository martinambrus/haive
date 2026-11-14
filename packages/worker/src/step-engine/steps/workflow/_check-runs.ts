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
): Promise<T> {
  const t = schema.taskCheckRuns;
  const attemptId = JSON.stringify([
    ctx.taskStepId,
    ctx.round ?? 0,
    ctx.rerunGeneration ?? 0,
    check.iteration,
  ]);
  let id: string | undefined;
  const startedAt = new Date();
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
        startedAt,
      })
      .onConflictDoNothing({ target: [t.taskId, t.stepId, t.slot, t.attemptId] })
      .returning({ id: t.id });
    id = inserted[0]?.id;
    if (!id) {
      const [existing] = await ctx.db
        .select({ id: t.id, outcome: t.outcome, startedAt: t.startedAt })
        .from(t)
        .where(
          and(
            eq(t.taskId, ctx.taskId),
            eq(t.stepId, check.stepId),
            eq(t.slot, check.slot),
            eq(t.attemptId, attemptId),
          ),
        );
      if (existing) {
        // Recovery repeats the command as before recording existed. Only the
        // observation is replaced; a lost CAS must never prevent execution.
        const [taken] = await ctx.db
          .update(t)
          .set({ outcome: 'running', startedAt, endedAt: null })
          .where(
            and(
              eq(t.id, existing.id),
              eq(t.outcome, existing.outcome),
              eq(t.startedAt, existing.startedAt),
            ),
          )
          .returning({ id: t.id });
        id = taken?.id;
      }
    }
  } catch (err) {
    ctx.logger.warn({ err }, 'check run insert/read/takeover failed (non-fatal)');
  }
  let outcome: CheckOutcome = 'interrupted';
  try {
    const result = await execute();
    try {
      outcome = classify(result);
    } catch (err) {
      ctx.logger.warn({ err }, 'check run classification failed (non-fatal)');
    }
    return result;
  } finally {
    if (id) {
      try {
        await ctx.db
          .update(t)
          .set({ outcome, endedAt: new Date() })
          .where(and(eq(t.id, id), eq(t.outcome, 'running'), eq(t.startedAt, startedAt)));
      } catch (err) {
        ctx.logger.warn({ err }, 'check run finalization failed (non-fatal)');
      }
    }
  }
}
