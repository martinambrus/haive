import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext } from './step-definition.js';
import { assertOwnsStep, StepSupersededError, taskWriteTarget } from './step-ownership.js';

type Receipt = NonNullable<typeof schema.taskSteps.$inferSelect.applyReceipt>;

/** Short metadata transactions only: never hold a connection while an external effect runs. */
async function withReceipt<T>(
  ctx: StepContext,
  fn: (receipt: Receipt | null, write: (receipt: Receipt) => Promise<void>) => Promise<T>,
): Promise<T> {
  ctx.throwIfCancelled();
  return ctx.db.transaction(async (tx) => {
    await assertOwnsStep(tx, ctx.taskStepId);
    const [task] = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(taskWriteTarget(ctx.taskId, ctx.epoch == null ? undefined : { epoch: ctx.epoch }))
      .for('share');
    if (!task) throw new StepSupersededError(ctx.taskStepId);
    const row = await tx.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, ctx.taskStepId),
    });
    if (!row) throw new StepSupersededError(ctx.taskStepId);
    return fn(row.applyReceipt ?? null, async (receipt) => {
      await tx
        .update(schema.taskSteps)
        .set({ applyReceipt: receipt })
        .where(eq(schema.taskSteps.id, ctx.taskStepId));
    });
  });
}

export async function beginApplyEffect(ctx: StepContext, kind: string, input: string) {
  return withReceipt(ctx, async (existing, write) => {
    if (existing) {
      if (existing.kind !== kind || existing.input !== input)
        throw new Error(
          'The approved operation changed after execution began. Retry this step to approve a new run.',
        );
      return { receipt: existing, fresh: false };
    }
    const receipt: Receipt = { id: randomUUID(), kind, input };
    await write(receipt);
    return { receipt, fresh: true };
  });
}

export async function finishApplyEffect(
  ctx: StepContext,
  receipt: Receipt,
  result: Record<string, unknown>,
) {
  return withReceipt(ctx, async (existing, write) => {
    if (existing?.id !== receipt.id) throw new StepSupersededError(ctx.taskStepId);
    await write({ ...receipt, result });
  });
}
