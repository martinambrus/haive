import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CheckOutcome, CheckSlot } from '@haive/database/schema';
import type { StepContext } from '../../step-definition.js';

type SettledOutcome = Exclude<CheckOutcome, 'running' | 'interrupted'>;
type Tx = Parameters<Parameters<StepContext['db']['transaction']>[0]>[0];

/** A recording write is observation only, so it may never hold up the check it observes: each
 *  runs in a transaction of its own under a server-side `statement_timeout`, which also bounds a
 *  wait on a row lock, and a statement past it is cancelled by the server and logged. */
export const CHECK_RUN_WRITE_TIMEOUT_MS = 5_000;
const bounded = <R>(ctx: StepContext, ms: number, run: (tx: Tx) => Promise<R>): Promise<R> =>
  ctx.db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${Math.trunc(ms)}ms'`));
    return run(tx);
  });

/** Like step 11's learningOutcomeId (#1168), identity survives recovery's epoch
 * bump and changes on explicit Retry. The loop iteration identifies 08b's passes.
 * Keep the step-row id inside the identity even after its FK is set null. */
export async function recordCheckRun<T>(
  ctx: StepContext,
  check: { stepId: string; slot: CheckSlot; iteration: number },
  execute: () => Promise<T>,
  classify: (result: T) => SettledOutcome,
  limits: { writeTimeoutMs?: number } = {},
): Promise<T> {
  const writeTimeoutMs = limits.writeTimeoutMs ?? CHECK_RUN_WRITE_TIMEOUT_MS;
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
    id = await bounded(ctx, writeTimeoutMs, async (tx) => {
      const inserted = await tx
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
      let taken = inserted[0]?.id;
      if (!taken) {
        const [existing] = await tx
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
          const [row] = await tx
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
          taken = row?.id;
        }
      }
      return taken;
    });
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
        const rowId = id;
        await bounded(ctx, writeTimeoutMs, (tx) =>
          tx
            .update(t)
            .set({ outcome, endedAt: new Date() })
            .where(and(eq(t.id, rowId), eq(t.outcome, 'running'), eq(t.startedAt, startedAt))),
        );
      } catch (err) {
        ctx.logger.warn({ err }, 'check run finalization failed (non-fatal)');
      }
    }
  }
}
