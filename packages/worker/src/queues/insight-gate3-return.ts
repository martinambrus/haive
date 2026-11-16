import { and, asc, desc, eq, gt, gte, lte, isNull, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { lockOwnedStep, StepSupersededError } from '../step-engine/step-ownership.js';
import { readInsightContinuation } from '../step-engine/steps/workflow/_insight-continuation.js';
import type { ResolvedTaskContext } from './run-list.js';

/** Failure is task-wide required state: replacing its source row cannot grant approval. */
export async function pendingInsightApproval(db: Database, taskId: string): Promise<string | null> {
  const events = await db
    .select({ payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, 'insight.check')),
    )
    .orderBy(asc(schema.taskEvents.createdAt), asc(schema.taskEvents.id));
  let pending: string | null = null;
  for (const e of events) {
    const p = e.payload;
    if (
      p?.version !== 1 ||
      typeof p.batchId !== 'string' ||
      !['verify_failed', 'gate2_approved'].includes(String(p.kind))
    )
      throw new Error('Unsupported insight check protocol.');
    pending = p.kind === 'verify_failed' ? p.batchId : null;
  }
  return pending;
}

/** Only the owner-authenticated submit route can attest a decision for this generation.
 * Saved defaults, queue payloads and legacy events are not human approval evidence. */
export async function freshInsightGate2Submission(
  db: Pick<Database, 'query'>,
  userId: string,
  row: typeof schema.taskSteps.$inferSelect,
): Promise<boolean> {
  const decision = row.formValues?.decision;
  if (
    row.stepId !== '09-gate-2-verify-approval' ||
    row.waitingStartedAt !== null ||
    (decision !== 'approve' && decision !== 'reject')
  )
    return false;
  const submission = await db.query.taskEvents.findFirst({
    where: and(
      eq(schema.taskEvents.taskId, row.taskId),
      eq(schema.taskEvents.taskStepId, row.id),
      eq(schema.taskEvents.eventType, 'step.form_submitted'),
      // Compare at PostgreSQL precision; JavaScript Dates truncate microseconds.
      gt(
        schema.taskEvents.createdAt,
        sql`(
        select max(failed.created_at) from ${schema.taskEvents} failed
        where failed.task_id = ${row.taskId} and failed.event_type = 'insight.check'
          and failed.payload->>'kind' = 'verify_failed'
      )`,
      ),
    ),
    orderBy: [desc(schema.taskEvents.createdAt), desc(schema.taskEvents.id)],
  });
  if (
    submission?.payload?.userId !== userId ||
    submission.payload.generation !== row.rerunGeneration ||
    submission.payload.decision !== decision
  )
    return false;
  return true;
}
/** A gate-3 cycle outlives its triage checkpoint and ordinary blocking fix rounds. */
export async function gate3InsightCycle(db: Database, taskId: string, round: number) {
  const events = await db.query.taskEvents.findMany({
    where: and(
      eq(schema.taskEvents.taskId, taskId),
      eq(schema.taskEvents.eventType, 'insight.continuation'),
    ),
    orderBy: [desc(schema.taskEvents.createdAt), desc(schema.taskEvents.id)],
  });
  const event = events.find((e) => {
    const c = readInsightContinuation(e.payload?.continuation);
    return c.mode === 'gate3' && c.stage === 'apply' && c.round <= round;
  });
  if (!event) return null;
  const request = readInsightContinuation(event.payload?.continuation);
  const source = await db.query.taskSteps.findFirst({
    where: and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.id, request.sourceStepRow)),
  });
  if (!source || source.rerunGeneration !== request.generation) return null;
  const gate = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '10-gate-3-commit'),
      gte(schema.taskSteps.round, request.round),
      lte(schema.taskSteps.round, round),
    ),
    orderBy: [desc(schema.taskSteps.round)],
  });
  if (gate?.status === 'done' || gate?.status === 'skipped') return null;
  return { request, verifyFailed: (await pendingInsightApproval(db, taskId)) !== null };
}
/** Required record before a failed verification can leave its row or an approval can advance. */
export async function recordGate3Check(
  db: Database,
  ctx: Pick<ResolvedTaskContext, 'taskId' | 'userId' | 'orchestrationEpoch'>,
  row: typeof schema.taskSteps.$inferSelect,
  kind: 'verify_failed' | 'gate2_approved',
): Promise<void> {
  const cycle = await gate3InsightCycle(db, ctx.taskId, row.round);
  const batchId =
    kind === 'gate2_approved'
      ? await pendingInsightApproval(db, ctx.taskId)
      : cycle?.request.batchId;
  if (!batchId) return;
  await db.transaction(async (tx) => {
    if (!(await lockOwnedStep(tx, row.id))) throw new StepSupersededError(row.id);
    const held = await tx.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, row.id) });
    if (!held || held.taskId !== ctx.taskId || held.rerunGeneration !== row.rerunGeneration)
      throw new StepSupersededError(row.id);
    const [task] = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, ctx.taskId),
          eq(schema.tasks.userId, ctx.userId),
          eq(schema.tasks.orchestrationEpoch, ctx.orchestrationEpoch),
          eq(schema.tasks.currentStepId, row.stepId),
          eq(schema.tasks.currentRound, row.round),
          isNull(schema.tasks.deadAt),
          notInArray(schema.tasks.status, ['failed', 'completed', 'cancelled']),
        ),
      )
      .for('share');
    if (!task) throw new StepSupersededError(row.id);
    if (kind === 'gate2_approved' && !(await freshInsightGate2Submission(tx, ctx.userId, held)))
      throw new Error('A fresh owner gate-2 submission is required after failed insight checks.');
    const previous = await tx.query.taskEvents.findMany({
      where: and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.taskStepId, row.id),
        eq(schema.taskEvents.eventType, 'insight.check'),
      ),
    });
    if (
      previous.some(
        (e) =>
          e.payload?.generation === row.rerunGeneration &&
          e.payload?.kind === kind &&
          e.payload?.batchId === batchId,
      )
    )
      return;
    await tx.insert(schema.taskEvents).values({
      taskId: ctx.taskId,
      taskStepId: row.id,
      eventType: 'insight.check',
      payload: { version: 1, batchId, generation: row.rerunGeneration, round: row.round, kind },
    });
  });
}
