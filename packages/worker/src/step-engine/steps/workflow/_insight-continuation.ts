import { lockOwnedStep, StepSupersededError, updateOwnedStep } from '../../step-ownership.js';
import { and, asc, desc, eq, gte, lte, isNull, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { InsightReviseContinuation } from '@haive/shared/step';
import { z } from 'zod';
import type { InsightBatchRecord } from './_insight-batch.js';

export const INSIGHT_CONTINUATION_EVENT = 'insight.continuation';
export const INSIGHT_VERIFY = '08-phase-5-verify';
const continuationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('insight_revise'),
    batchId: z.string().min(1),
    sourceStepRow: z.string().min(1),
    generation: z.number().int().nonnegative(),
    round: z.number().int().positive(),
  })
  .strict();
const checkpointSchema = z
  .object({
    stepRowId: z.string().min(1),
    round: z.number().int().positive(),
    generation: z.number().int().nonnegative(),
  })
  .strict();
export function readInsightContinuation(value: unknown): InsightReviseContinuation {
  if ((value as { version?: unknown } | null)?.version !== 1)
    throw new Error('Unsupported insight continuation protocol version.');
  return continuationSchema.parse(value);
}

/** Only the required, stored journal outcome can authorize a new check round. */
export function continuationForOutcome(
  record: InsightBatchRecord,
  sourceRound: number,
): InsightReviseContinuation | undefined {
  if (
    record.stage !== 'outcome' ||
    record.selected.length === 0 ||
    !record.items.some((i) => i.outcome === 'applied')
  )
    return undefined;
  return {
    version: 1,
    kind: 'insight_revise',
    batchId: record.batchId,
    sourceStepRow: record.sourceStepRowId,
    generation: record.generation,
    round: sourceRound + 1,
  };
}

/** A downstream Retry keeps the route; replacing its source generation invalidates it.
 * A completed checkpoint settles the route. Retrying that checkpoint reopens it. */
export async function activeInsightContinuation(
  db: Database,
  taskId: string,
  round: number,
): Promise<InsightReviseContinuation | null> {
  const events = await db.query.taskEvents.findMany({
    where: and(
      eq(schema.taskEvents.taskId, taskId),
      eq(schema.taskEvents.eventType, INSIGHT_CONTINUATION_EVENT),
    ),
    orderBy: [desc(schema.taskEvents.createdAt)],
  });
  for (const event of events) {
    const continuation = readInsightContinuation(event.payload?.continuation);
    if (continuation.round > round) continue;
    const source = await db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.id, continuation.sourceStepRow),
        eq(schema.taskSteps.taskId, taskId),
      ),
    });
    if (!source || source.rerunGeneration !== continuation.generation) continue;
    // Publication records which checkpoint this route reached. A verification Retry can
    // leave an older pending row behind when a fix round moves the forward walk on.
    const owned =
      event.payload?.checkpoint == null ? null : checkpointSchema.parse(event.payload.checkpoint);
    const checkpoint = await db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, '08e-insights-triage'),
        ...(owned
          ? [eq(schema.taskSteps.id, owned.stepRowId), eq(schema.taskSteps.round, owned.round)]
          : [gte(schema.taskSteps.round, continuation.round), lte(schema.taskSteps.round, round)]),
      ),
      orderBy: [asc(schema.taskSteps.round)],
    });
    return checkpoint?.status === 'done' || checkpoint?.status === 'skipped' ? null : continuation;
  }
  return null;
}

/** The final output has the journal's same source, owner and epoch fence. */
export async function publishInsightStep(
  ctx: import('../../step-definition.js').StepContext,
  patch: Parameters<typeof updateOwnedStep>[2],
): Promise<typeof schema.taskSteps.$inferSelect> {
  ctx.throwIfCancelled();
  return ctx.db.transaction(async (tx) => {
    if (!(await lockOwnedStep(tx, ctx.taskStepId))) throw new StepSupersededError(ctx.taskStepId);
    const source = await tx.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, ctx.taskStepId),
    });
    if (
      !source ||
      source.taskId !== ctx.taskId ||
      source.rerunGeneration !== (ctx.rerunGeneration ?? 0)
    )
      throw new StepSupersededError(ctx.taskStepId);
    const [task] = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, ctx.taskId),
          eq(schema.tasks.userId, ctx.userId),
          ...(ctx.epoch == null ? [] : [eq(schema.tasks.orchestrationEpoch, ctx.epoch)]),
          isNull(schema.tasks.deadAt),
          notInArray(schema.tasks.status, ['failed', 'cancelled', 'completed']),
        ),
      )
      .for('share');
    if (!task) throw new StepSupersededError(ctx.taskStepId);
    ctx.throwIfCancelled();
    const checkpoint = (patch.output as { insightCheckpoint?: unknown } | null)?.insightCheckpoint;
    if (checkpoint) {
      const continuation = readInsightContinuation(checkpoint);
      const events = await tx.query.taskEvents.findMany({
        where: and(
          eq(schema.taskEvents.taskId, ctx.taskId),
          eq(schema.taskEvents.eventType, INSIGHT_CONTINUATION_EVENT),
        ),
      });
      const event = events.find(
        (e) =>
          JSON.stringify(readInsightContinuation(e.payload?.continuation)) ===
          JSON.stringify(continuation),
      );
      if (!event || source.round < continuation.round)
        throw new Error('Insight checkpoint has no matching continuation handoff.');
      // Keep the exact row identity across Retry, which resets output and increments
      // generation. Its current status, including pending after Retry, decides closure.
      await tx
        .update(schema.taskEvents)
        .set({
          payload: {
            ...event.payload,
            checkpoint: {
              stepRowId: source.id,
              round: source.round,
              generation: source.rerunGeneration,
            },
          },
        })
        .where(eq(schema.taskEvents.id, event.id));
    }
    return updateOwnedStep(tx, ctx.taskStepId, patch);
  });
}
