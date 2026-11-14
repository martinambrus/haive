import { createHash } from 'node:crypto';
import { schema } from '@haive/database';
import type { StepContext } from '../../step-definition.js';

/** Measurement event, deliberately separate from the learning refinement channel. */
export const LEARNING_RECONCILED_EVENT = 'learning.reconciled';
export type LearningOpCounts = Record<'insert' | 'update' | 'delete', number>;
export const emptyOpCounts = (): LearningOpCounts => ({ insert: 0, update: 0, delete: 0 });
export const countLearningOps = (
  entries: readonly { op: keyof LearningOpCounts }[],
): LearningOpCounts => {
  const counts = emptyOpCounts();
  for (const entry of entries) counts[entry.op]++;
  return counts;
};

/** Parsed means structurally usable BEFORE admission; kept is AFTER admission. Only
 * the file:line rule is machine checked. Prompt advice is never a rejection reason. */
export function admissionCounts() {
  return { proposed: 0, parsed: 0, invalid: 0, rejected: { file_line_evidence: 0 } };
}
export type LearningAdmissionCounts = ReturnType<typeof admissionCounts>;
export const candidateWrites = () => ({ attempted: 0, succeeded: 0, failed: 0, notWritten: 0 });

export function learningOutcome(listed: { total: number; withExcerpt: number; omitted: number }) {
  return {
    version: 1 as const,
    status: 'failed' as 'failed' | 'completed' | 'refine_requested',
    source: 'stub' as 'stub' | 'llm',
    listed,
    learnings: {
      ...admissionCounts(),
      reviewed: false,
      kept: emptyOpCounts(),
      planned: emptyOpCounts(),
      downgraded: { updateToInsert: 0, deleteDropped: 0 },
      human: { removed: 0, edited: 0, excluded: 0 },
      approved: emptyOpCounts(),
      writes: { attempted: emptyOpCounts(), succeeded: emptyOpCounts(), failed: emptyOpCounts() },
    },
    investigation: {
      proposed: 0,
      parsed: 0,
      reviewed: false,
      kept: 0,
      humanRemoved: 0,
      humanEdited: 0,
      writes: candidateWrites(),
    },
    globalCandidates: { ...admissionCounts(), kept: 0, writes: candidateWrites() },
  };
}
export type LearningOutcome = ReturnType<typeof learningOutcome>;

/** Recovery advances the task epoch, but preserves rerun_generation. Explicit
 * Retry advances that generation even when it retains the same form/invocation.
 * Use the existing primary key for atomic deduplication, with no read/insert race.
 * Nothing from the repository or reply becomes an event identity or payload. */
export function learningOutcomeId(ctx: StepContext, invocationId?: string | null): string {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        LEARNING_RECONCILED_EVENT,
        ctx.taskId,
        ctx.taskStepId,
        ctx.round ?? 0,
        ctx.rerunGeneration ?? 0,
        invocationId ?? null,
      ]),
    )
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** First observation wins on replay: a later pass must not replace a partial
 * failure's counts with a reconciliation against files the first pass wrote.
 * These are measurements, not an audit prerequisite for the filesystem writes. */
export async function recordLearningOutcome(
  ctx: StepContext,
  outcome: LearningOutcome,
  invocationId?: string | null,
): Promise<void> {
  try {
    await ctx.db
      .insert(schema.taskEvents)
      .values({
        id: learningOutcomeId(ctx, invocationId),
        taskId: ctx.taskId,
        taskStepId: ctx.taskStepId,
        eventType: LEARNING_RECONCILED_EVENT,
        payload: {
          ...outcome,
          attempt: {
            round: ctx.round ?? 0,
            generation: ctx.rerunGeneration ?? 0,
            invocationId: invocationId ?? null,
          },
        },
      })
      .onConflictDoNothing({ target: schema.taskEvents.id });
  } catch (err) {
    ctx.logger.warn({ err }, 'learning reconcile event insert failed (non-fatal)');
  }
}

/** Count only completed operations; preserve the original failure for the step. */
export async function observeCandidateWrite<T>(
  counts: ReturnType<typeof candidateWrites>,
  write: () => Promise<T>,
): Promise<T> {
  counts.attempted++;
  try {
    const result = await write();
    if (result) counts.succeeded++;
    else counts.notWritten++;
    return result;
  } catch (err) {
    counts.failed++;
    throw err;
  }
}
