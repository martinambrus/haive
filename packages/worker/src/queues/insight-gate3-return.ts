import { and, asc, desc, eq, gt, gte, inArray, lte, isNull, notInArray, sql } from 'drizzle-orm';
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

/** Required while the latest insight check is a gate-2 approval. It settles once a completed
 * gate-3 row carries the owner's answer for its current generation, written after that approval.
 * A Retry that re-runs the answered row, or a newer approval, withdraws the answer, so the form
 * stays human-only across Retry, Resume and worker takeover whatever round it runs at. */
async function failedInsightGate3ReviewRequired(
  db: Database,
  row: typeof schema.taskSteps.$inferSelect,
): Promise<boolean> {
  const latest = await db.query.taskEvents.findFirst({
    where: and(
      eq(schema.taskEvents.taskId, row.taskId),
      eq(schema.taskEvents.eventType, 'insight.check'),
    ),
    orderBy: [desc(schema.taskEvents.createdAt), desc(schema.taskEvents.id)],
  });
  if (
    latest &&
    (latest.payload?.version !== 1 ||
      typeof latest.payload.batchId !== 'string' ||
      !['verify_failed', 'gate2_approved'].includes(String(latest.payload.kind)))
  )
    throw new Error('Unsupported insight check protocol.');
  const approvedRound = latest?.payload?.round;
  if (latest?.payload?.kind !== 'gate2_approved') return false;
  if (typeof approvedRound !== 'number' || !Number.isInteger(approvedRound) || approvedRound < 0)
    throw new Error('Unsupported insight approval round.');
  const answered = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, row.taskId),
      eq(schema.taskSteps.stepId, '10-gate-3-commit'),
      inArray(schema.taskSteps.status, ['done', 'skipped']),
      sql`exists (
        select 1 from ${schema.taskEvents} submitted, ${schema.taskEvents} approved, ${schema.tasks} owned
        where approved.id = ${latest.id} and owned.id = ${row.taskId} and submitted.task_id = ${row.taskId}
          and submitted.task_step_id = ${schema.taskSteps.id} and submitted.event_type = ${'step.form_submitted'}
          and submitted.payload->>'userId' = owned.user_id::text
          and submitted.payload->>'generation' = ${schema.taskSteps.rerunGeneration}::text
          and submitted.created_at > approved.created_at
      )`,
    ),
  });
  return !answered;
}

/** A gate-3 pick keeps its first gate 3 human-only, whether or not the cycle's verification failed. */
export async function insightGate3ReviewRequired(
  db: Database,
  row: typeof schema.taskSteps.$inferSelect,
): Promise<boolean> {
  return (
    (await failedInsightGate3ReviewRequired(db, row)) ||
    (await openGate3Cycle(db, row.taskId, row.round)) !== null
  );
}

/** Only the owner-authenticated submit route can attest an answer for this generation.
 * Saved defaults, queue payloads and legacy events are not human approval evidence. */
export async function freshInsightGateSubmission(
  db: Pick<Database, 'query'>,
  userId: string,
  row: typeof schema.taskSteps.$inferSelect,
): Promise<boolean> {
  const gate3 = row.stepId === '10-gate-3-commit';
  const decision = row.formValues?.decision;
  if (
    (!gate3 && row.stepId !== '09-gate-2-verify-approval') ||
    row.waitingStartedAt !== null ||
    (gate3
      ? typeof row.formValues?.commit !== 'boolean'
      : decision !== 'approve' && decision !== 'reject')
  )
    return false;
  const cycle = await openGate3Cycle(db, row.taskId, row.round);
  const checked = sql`(
        select max(failed.created_at) from ${schema.taskEvents} failed
        where failed.task_id = ${row.taskId} and failed.event_type = 'insight.check'
          and failed.payload->>'kind' = ${gate3 ? 'gate2_approved' : 'verify_failed'}
      )`;
  const submission = await db.query.taskEvents.findFirst({
    where: and(
      eq(schema.taskEvents.taskId, row.taskId),
      eq(schema.taskEvents.taskStepId, row.id),
      eq(schema.taskEvents.eventType, 'step.form_submitted'),
      // Compare at PostgreSQL precision; JavaScript Dates truncate microseconds.
      gt(
        schema.taskEvents.createdAt,
        cycle
          ? sql`greatest(${checked}, (
        select started.created_at from ${schema.taskEvents} started where started.id = ${cycle.event.id}
      ))`
          : checked,
      ),
    ),
    orderBy: [desc(schema.taskEvents.createdAt), desc(schema.taskEvents.id)],
  });
  if (
    submission?.payload?.userId !== userId ||
    submission.payload.generation !== row.rerunGeneration ||
    (gate3
      ? submission.payload.commit !== row.formValues?.commit
      : submission.payload.decision !== decision)
  )
    return false;
  return true;
}
/** The latest gate-3 apply request at or before `round`, once its source row is still the one it named. */
async function latestGate3Request(db: Pick<Database, 'query'>, taskId: string, round: number) {
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
  return { event, request };
}
/** The newest gate-3 apply request of the task, whatever round or source-row generation it recorded.
 *  A person's pick writes the event once and no Retry or reset touches it, so it proves the cycle
 *  began even after a Retry re-ran the source row at a lower round or a higher generation. */
async function latestGate3Cycle(db: Pick<Database, 'query'>, taskId: string) {
  const events = await db.query.taskEvents.findMany({
    where: and(
      eq(schema.taskEvents.taskId, taskId),
      eq(schema.taskEvents.eventType, 'insight.continuation'),
    ),
    orderBy: [desc(schema.taskEvents.createdAt), desc(schema.taskEvents.id)],
  });
  const event = events.find((e) => {
    const c = readInsightContinuation(e.payload?.continuation);
    return c.mode === 'gate3' && c.stage === 'apply';
  });
  return event ? { event, request: readInsightContinuation(event.payload?.continuation) } : null;
}
/** The gate-3 cycle whose first gate 3 is still owed to a person, or null once it was settled.
 *  The cycle event proves it; a Retry never ends it. Two things settle it: an earlier gate-3 row at
 *  or after the cycle's round that is done or skipped, or the pick's source row, reset by a Retry
 *  after the pick and completed again at a round below this one, which shows a person passed that
 *  gate again. The source row's own generation at the pick settles nothing. */
export async function openGate3Cycle(db: Pick<Database, 'query'>, taskId: string, round: number) {
  const found = await latestGate3Cycle(db, taskId);
  if (!found) return null;
  const settled = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '10-gate-3-commit'),
      gte(schema.taskSteps.round, found.request.round),
      sql`${schema.taskSteps.round} < ${round}`,
      inArray(schema.taskSteps.status, ['done', 'skipped']),
    ),
  });
  if (settled) return null;
  const source = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.id, found.request.sourceStepRow),
    ),
  });
  if (
    source &&
    source.round < round &&
    (source.status === 'done' || source.status === 'skipped') &&
    source.rerunGeneration > found.request.generation
  )
    return null;
  return found;
}
/** A gate-3 cycle outlives its triage checkpoint and ordinary blocking fix rounds. */
export async function gate3InsightCycle(db: Database, taskId: string, round: number) {
  const found = await latestGate3Request(db, taskId, round);
  if (!found) return null;
  const { request } = found;
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
/** A gate 2 that runs inside an open gate-3 cycle because its accepted QA review deferred findings to it. */
export async function insightGate2QaKept(
  db: Database,
  row: typeof schema.taskSteps.$inferSelect,
): Promise<boolean> {
  const cycle = await openGate3Cycle(db, row.taskId, row.round);
  return cycle !== null && (await gate3QaDeferred(db, row.taskId, cycle.request.round, row.round));
}
/** An accepted QA review waives nothing and defers its findings to gate 2, so gate 2 must still run. */
export async function gate3QaDeferred(
  db: Database,
  taskId: string,
  fromRound: number,
  toRound: number,
): Promise<boolean> {
  const qa = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '08d2-adversarial-qa-review'),
      inArray(schema.taskSteps.status, ['done', 'skipped']),
      gte(schema.taskSteps.round, fromRound),
      lte(schema.taskSteps.round, toRound),
    ),
    orderBy: [
      desc(schema.taskSteps.round),
      desc(schema.taskSteps.runSeq),
      desc(schema.taskSteps.createdAt),
    ],
  });
  return (
    qa?.status === 'done' && (qa.output as { decision?: string } | null)?.decision === 'accept'
  );
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
    if (kind === 'gate2_approved' && !(await freshInsightGateSubmission(tx, ctx.userId, held)))
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
