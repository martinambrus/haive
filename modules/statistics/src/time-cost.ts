import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  buildTimeCostReport,
  FORM_WAIT_EVENT_TYPES,
  type TimeCostStep,
  type FormWaitEvent,
  type TimeCostInvocation,
} from '@haive/shared/stats';
import { realCostUsdSql, notionalCostUsdSql, pricedCostRowSql } from '@haive/shared/stats-server';

export const TIME_COST_BATCH_SIZE = 200;

/** Bounded parameters on every task-id query, including enrichment after the display cap.
 * Timing, costs and waits cover the task's whole history; only the population is windowed. */
export async function timeCostOver(
  db: Database,
  tasks: { id: string; completedAt: Date | null }[],
  attribution: SQL,
  batchSize = TIME_COST_BATCH_SIZE,
) {
  const steps: TimeCostStep[] = [];
  const events: FormWaitEvent[] = [];
  const invocations: TimeCostInvocation[] = [];
  let excludedLegacyInvocations = 0;
  const inv = schema.cliInvocations;
  const ts = schema.taskSteps;
  const te = schema.taskEvents;
  for (let offset = 0; offset < tasks.length; offset += batchSize) {
    const ids = tasks.slice(offset, offset + batchSize).map((t) => t.id);
    const [stepRows, eventRows, runRows, excluded] = await Promise.all([
      db
        .select({
          id: ts.id,
          taskId: ts.taskId,
          stepId: ts.stepId,
          status: ts.status,
          startedAt: ts.startedAt,
          endedAt: ts.endedAt,
          idleMs: ts.idleMs,
          userActiveMs: ts.userActiveMs,
          waitingStartedAt: ts.waitingStartedAt,
          carriedWorkMs: ts.carriedWorkMs,
          carriedIdleMs: ts.carriedIdleMs,
          carriedUserActiveMs: ts.carriedUserActiveMs,
          // Read only the persisted test outcome, never the (potentially large) whole output.
          output: sql<{
            test: { ran: boolean | null };
          }>`jsonb_build_object('test', jsonb_build_object('ran', ${ts.output}->'test'->'ran'))`,
        })
        .from(ts)
        .where(inArray(ts.taskId, ids)),
      db
        .select({
          id: te.id,
          taskId: te.taskId,
          taskStepId: te.taskStepId,
          eventType: te.eventType,
          createdAt: sql<string>`to_char(${te.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(te)
        .where(and(inArray(te.taskId, ids), inArray(te.eventType, FORM_WAIT_EVENT_TYPES)))
        .orderBy(te.taskId, te.createdAt, te.id),
      db
        .select({
          taskId: inv.taskId,
          stepId: ts.stepId,
          agentMs: sql<number>`coalesce(sum(greatest(0, extract(epoch from (${inv.endedAt} - ${inv.startedAt})) * 1000)) filter (where ${inv.startedAt} is not null and ${inv.endedAt} is not null), 0)::double precision`,
          realUsd: realCostUsdSql(),
          notionalUsd: notionalCostUsdSql(),
          invocations: sql<number>`count(*)::int`,
          pricedInvocations: sql<number>`count(*) filter (where ${pricedCostRowSql()})::int`,
          unpricedInvocations: sql<number>`count(*) filter (where not ${pricedCostRowSql()})::int`,
          unsnapshottedInvocations: sql<number>`count(*) filter (where ${inv.cost} is null)::int`,
        })
        .from(inv)
        .leftJoin(
          ts,
          and(
            eq(ts.taskId, inv.taskId),
            sql`${ts.id} = coalesce(${inv.taskStepId}, ${inv.summaryForStepId})`,
          ),
        )
        .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, inv.cliProviderId))
        .where(and(inArray(inv.taskId, ids), attribution))
        .groupBy(inv.taskId, ts.stepId),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(inv)
        .where(
          and(
            inArray(inv.taskId, ids),
            isNull(inv.supersededAt),
            isNull(inv.taskStepId),
            isNull(inv.summaryForStepId),
          ),
        ),
    ]);
    steps.push(...stepRows);
    events.push(...eventRows);
    invocations.push(...runRows);
    excludedLegacyInvocations += Number(excluded[0]?.n ?? 0);
  }
  const report = buildTimeCostReport({
    tasks: tasks
      .filter((t): t is { id: string; completedAt: Date } => t.completedAt !== null)
      .map((t) => ({ taskId: t.id, completedAt: t.completedAt })),
    steps,
    events,
    invocations,
  });
  const details = new Map<string, { title: string; repository: string | null }>();
  for (let offset = 0; offset < report.rows.length; offset += batchSize) {
    const ids = report.rows.slice(offset, offset + batchSize).map((r) => r.taskId);
    const rows = await db
      .select({
        taskId: schema.tasks.id,
        title: schema.tasks.title,
        repository: schema.repositories.name,
      })
      .from(schema.tasks)
      .leftJoin(schema.repositories, eq(schema.repositories.id, schema.tasks.repositoryId))
      .where(inArray(schema.tasks.id, ids));
    for (const r of rows) details.set(r.taskId, r);
  }
  return {
    ...report,
    excludedLegacyInvocations,
    rows: report.rows.map((r) => ({
      ...r,
      title: details.get(r.taskId)?.title ?? 'Task',
      repository: details.get(r.taskId)?.repository ?? null,
    })),
  };
}
