import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { readStepRole, STEP_ROLES } from '@haive/shared/step-outputs';
import type { InsightReviseContinuation } from '@haive/shared/step';
import type { StepDefinition } from '../step-engine/step-definition.js';
import { lockOwnedStep, StepSupersededError } from '../step-engine/step-ownership.js';
import {
  continuationForOutcome,
  INSIGHT_CONTINUATION_EVENT,
  INSIGHT_VERIFY,
  readInsightContinuation,
} from '../step-engine/steps/workflow/_insight-continuation.js';
import { loadInsightBatchRecords } from '../step-engine/steps/workflow/_insight-batch.js';
import type { ResolvedTaskContext } from './run-list.js';
import { resetStepAndDownstream } from './_step-reset.js';
import { validationSuccessor, VALIDATION_RECHECK_EVENT } from './validation-recheck.js';

export class InsightRunListError extends Error {
  constructor() {
    super(
      'Insight continuation requires verification, code review and insight triage in the run list. Repair the task type and Retry this step.',
    );
    this.name = 'InsightRunListError';
  }
}

/** Check all destinations before a reset. An old/custom pin must never run off-list. */
export function assertInsightRunList(
  steps: readonly StepDefinition[],
  reviewStepId: string | null = STEP_ROLES.codeReview,
): void {
  const ids = steps.map((s) => s.metadata.id);
  const verify = ids.indexOf(INSIGHT_VERIFY);
  const checkpoint = ids.indexOf('08e-insights-triage');
  const review = steps.findIndex((s) => s.metadata.id === reviewStepId);
  if (verify < 0 || review <= verify || checkpoint <= review) throw new InsightRunListError();
}

/** Resolve the review through the immutable pin; a standalone declaration cannot impersonate it. */
export function assertInsightTaskSteps(
  ctx: ResolvedTaskContext,
  steps: readonly StepDefinition[],
): void {
  const review = readStepRole(ctx, STEP_ROLES.codeReview, (binding) =>
    binding.state === 'active' ? binding.stepId : null,
  );
  assertInsightRunList(steps, review);
}

export async function handoffInsightContinuation(
  db: Database,
  ctx: ResolvedTaskContext,
  source: typeof schema.taskSteps.$inferSelect,
  value: InsightReviseContinuation,
  steps: readonly StepDefinition[],
): Promise<{ next: StepDefinition; round: number; epoch: number } | null> {
  const continuation = readInsightContinuation(value);
  assertInsightTaskSteps(ctx, steps);
  if (
    continuation.sourceStepRow !== source.id ||
    continuation.generation !== source.rerunGeneration ||
    continuation.round !== source.round + 1
  )
    throw new StepSupersededError(source.id);
  const journal = await loadInsightBatchRecords(db, ctx.taskId);
  const outcome = journal.find((r) => r.batchId === continuation.batchId && r.stage === 'outcome');
  if (
    !outcome ||
    JSON.stringify(continuationForOutcome(outcome, source.round)) !== JSON.stringify(continuation)
  )
    throw new Error('Insight continuation has no matching applied journal outcome.');
  // File reads precede every lock. The same recheck rule serves ordinary late editors.
  const successor = await validationSuccessor(
    db,
    ctx,
    source.stepId,
    source.round,
    steps,
    source.output,
    INSIGHT_VERIFY,
  );
  const next = successor.recheck
    ? successor.next!
    : steps.find((s) => s.metadata.id === INSIGHT_VERIFY)!;
  const round = continuation.round;
  try {
    return await db.transaction(async (tx) => {
      // The reset takes runs first and all overlapping step rows in id order, including source.
      // Keeping it in this transaction makes its epoch bump, route event and pointer atomic.
      // Retry of the source can change an earlier direct-verify route into a validation
      // route. That new target has no row, while its downstream may contain old results.
      const range = steps.slice(steps.indexOf(next)).map((step) => step.metadata.id);
      const prior = await tx.query.taskSteps.findMany({
        where: and(
          eq(schema.taskSteps.taskId, ctx.taskId),
          eq(schema.taskSteps.round, round),
          inArray(schema.taskSteps.stepId, range),
        ),
      });
      const firstExisting = range.find((id) => prior.some((row) => row.stepId === id));
      const reset = await resetStepAndDownstream(
        tx as unknown as Database,
        ctx.taskId,
        firstExisting ?? next.metadata.id,
        round,
        ctx.orchestrationEpoch,
        false,
        [source.id],
      );
      if (reset === 'superseded') throw new StepSupersededError(source.id);
      if (!(await lockOwnedStep(tx, source.id))) throw new StepSupersededError(source.id);
      const held = await tx.query.taskSteps.findFirst({
        where: eq(schema.taskSteps.id, source.id),
      });
      if (
        !held ||
        held.status !== 'done' ||
        held.taskId !== ctx.taskId ||
        held.rerunGeneration !== continuation.generation
      )
        throw new StepSupersededError(source.id);
      const epoch = reset?.newEpoch ?? ctx.orchestrationEpoch;
      const [pointed] = await tx
        .update(schema.tasks)
        .set({
          status: 'running',
          completedAt: null,
          errorMessage: null,
          currentStepId: next.metadata.id,
          currentStepIndex:
            (
              await tx.query.taskSteps.findFirst({
                where: and(
                  eq(schema.taskSteps.taskId, ctx.taskId),
                  eq(schema.taskSteps.stepId, next.metadata.id),
                  eq(schema.taskSteps.round, round),
                ),
              })
            )?.runSeq ?? 100 + next.metadata.index,
          currentRound: round,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.tasks.id, ctx.taskId),
            eq(schema.tasks.userId, ctx.userId),
            eq(schema.tasks.orchestrationEpoch, epoch),
            eq(schema.tasks.currentStepId, source.stepId),
            eq(schema.tasks.currentRound, source.round),
            isNull(schema.tasks.deadAt),
            notInArray(schema.tasks.status, ['failed', 'cancelled', 'completed']),
          ),
        )
        .returning({ id: schema.tasks.id });
      if (!pointed) throw new StepSupersededError(source.id);
      const events = await tx.query.taskEvents.findMany({
        where: and(
          eq(schema.taskEvents.taskId, ctx.taskId),
          eq(schema.taskEvents.eventType, INSIGHT_CONTINUATION_EVENT),
        ),
      });
      const existing = events.find(
        (e) => readInsightContinuation(e.payload?.continuation).batchId === continuation.batchId,
      );
      if (!existing)
        await tx.insert(schema.taskEvents).values({
          taskId: ctx.taskId,
          taskStepId: source.id,
          eventType: INSIGHT_CONTINUATION_EVENT,
          payload: { continuation, targetStepId: next.metadata.id },
        });
      if (successor.recheck && !existing)
        await tx.insert(schema.taskEvents).values({
          taskId: ctx.taskId,
          taskStepId: source.id,
          eventType: VALIDATION_RECHECK_EVENT,
          payload: { round, ...successor.recheck },
        });
      return { next, round, epoch };
    });
  } catch (err) {
    if (err instanceof StepSupersededError) return null;
    throw err;
  }
}
