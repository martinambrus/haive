import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { StepContext } from '../../step-definition.js';

// Durable channel for the fix-loop diagnosis. When a downstream step finds a blocking
// defect it returns `loop_back`; handleResult records the diagnosis here and re-enters
// at the implementation step at round N. The round-N implement reads the request for
// its own round and runs in fix mode. task_events are append-only and survive step-row
// materialization, and the `round` in the payload disambiguates which request belongs
// to which fix round (mirrors _biz-req-feedback.ts).

/** The step every fix round re-enters at: the implementation phase re-runs in fix
 *  mode, then the whole post-implementation chain re-runs as new round-N rows. */
export const FIX_LOOP_TARGET_STEP_ID = '07-phase-2-implement';
/** Fallback cap when a task predates tasks.max_fix_rounds (set on the Gate-1 form). */
export const DEFAULT_MAX_FIX_ROUNDS = 5;
const FIX_LOOP_REQUESTED = 'fix_loop.requested';

export interface FixLoopRequest {
  diagnosis: string;
  sourceStepId: string;
  round: number;
}

/** Record a fix-loop request as a task_event so the round-N implement can read it. */
export async function recordFixLoopRequest(
  db: Database,
  taskId: string,
  sourceTaskStepId: string,
  req: FixLoopRequest,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId: sourceTaskStepId,
    eventType: FIX_LOOP_REQUESTED,
    payload: { ...req },
  });
}

/** The diagnosis the implementation step should fix on this round, or null on the
 *  original pass (round 0) or when no recorded request matches the current round. */
export async function loadFixLoopDiagnosis(ctx: StepContext): Promise<string | null> {
  if (ctx.round <= 0) return null;
  const rows = await ctx.db
    .select()
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.eventType, FIX_LOOP_REQUESTED),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt));
  for (const r of rows) {
    const p = r.payload as { diagnosis?: string; round?: number } | null;
    if (p?.round === ctx.round) {
      const d = (p.diagnosis ?? '').trim();
      return d.length > 0 ? d : null;
    }
  }
  return null;
}
