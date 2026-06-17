import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext } from '../../step-definition.js';

// Durable channel for the gate-1 spec-approval decision (06), mirroring
// _biz-req-feedback.ts. The reject path re-enters the spec generator (04) via the
// `revise` route, which resets the 04..06 step rows — so the reviewer's feedback cannot
// live on those rows. task_events are append-only and survive the reset, so 06 records
// its decision here and 04 reads the latest outstanding rejection to pre-fill (and
// auto-submit) its revision guidance on the re-draft.

const REJECTED = 'spec.rejected';
const APPROVED = 'spec.approved';

/** Record the 06 spec-gate decision as a task_event so it outlives the step rows. */
export async function recordSpecDecision(
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

/** The most recent spec rejection feedback that has NOT since been re-approved, or ''
 *  when the last decision was an approval (or there was none). 04 pre-fills this into its
 *  scope/feedback field so a re-draft addresses what the reviewer asked for. */
export async function loadOutstandingSpecFeedback(ctx: StepContext): Promise<string> {
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
