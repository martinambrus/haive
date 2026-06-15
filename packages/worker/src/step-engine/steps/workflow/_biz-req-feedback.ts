import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext } from '../../step-definition.js';

// Durable channel for the business-requirements review decision (03c). The reject
// path throws to halt the task, and the retry that revises resets the 03b/03c step
// rows — so the reviewer's feedback cannot live on those rows. task_events are
// append-only and survive the reset, so 03c records its decision here and 03b reads
// the latest outstanding rejection to pre-fill its guidance on the re-mine.

const REJECTED = 'business_requirements.rejected';
const APPROVED = 'business_requirements.approved';

/** Record the 03c review decision as a task_event so it outlives the step rows. */
export async function recordBizReqDecision(
  ctx: StepContext,
  decision: 'approve' | 'reject',
  feedback: string,
): Promise<void> {
  await ctx.db.insert(schema.taskEvents).values({
    taskId: ctx.taskId,
    taskStepId: ctx.taskStepId,
    eventType: decision === 'reject' ? REJECTED : APPROVED,
    payload: { feedback },
  });
}

/** The most recent rejection feedback that has NOT since been re-approved, or ''
 *  when the last review decision was an approval (or there was none). 03b pre-fills
 *  this into its guidance so a re-mine addresses what the reviewer asked for. */
export async function loadOutstandingBizReqFeedback(ctx: StepContext): Promise<string> {
  const rows = await ctx.db
    .select()
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        inArray(schema.taskEvents.eventType, [REJECTED, APPROVED]),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt))
    .limit(1);
  const latest = rows[0];
  if (!latest || latest.eventType !== REJECTED) return '';
  return ((latest.payload as { feedback?: string } | null)?.feedback ?? '').trim();
}
