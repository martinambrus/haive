import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext } from '../../step-definition.js';

// Durable channel for a learning-step refinement instruction, mirroring
// _spec-feedback.ts. A non-blank instruction on the learning form re-enters the
// SAME step (11) via the `revise` route, which resets the step row — so the
// instruction cannot live on that row. task_events are append-only and survive
// the reset (resetStepAndDownstream preserves them), so the form records the
// instruction here and the step's detect/buildPrompt reads the latest outstanding
// one on re-entry to steer the agent. An accept (blank submit) closes the channel.

const REFINE = 'learning.refine';
const ACCEPTED = 'learning.accepted';

/** Record a reviewer's refinement instruction as a task_event so it outlives the
 *  step row across the self-targeted revise reset. */
export async function recordLearningInstruction(
  ctx: StepContext,
  instruction: string,
): Promise<void> {
  await ctx.db.insert(schema.taskEvents).values({
    taskId: ctx.taskId,
    taskStepId: ctx.taskStepId,
    eventType: REFINE,
    payload: { instruction },
  });
}

/** Close the channel when the reviewer accepts the drafts (blank instruction), so a
 *  later, unrelated run of this step does not re-apply a stale instruction. */
export async function recordLearningAccepted(ctx: StepContext): Promise<void> {
  await ctx.db.insert(schema.taskEvents).values({
    taskId: ctx.taskId,
    taskStepId: ctx.taskStepId,
    eventType: ACCEPTED,
    payload: {},
  });
}

/** The most recent refinement instruction that has NOT since been accepted, or ''
 *  when the last decision was an accept (or there was none). The learning step's
 *  detect reads this and buildPrompt injects it as a directive on the re-run. */
export async function loadOutstandingLearningInstruction(ctx: StepContext): Promise<string> {
  const rows = await ctx.db
    .select()
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        inArray(schema.taskEvents.eventType, [REFINE, ACCEPTED]),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt))
    .limit(1);
  const latest = rows[0];
  if (!latest || latest.eventType !== REFINE) return '';
  return ((latest.payload as { instruction?: string } | null)?.instruction ?? '').trim();
}
