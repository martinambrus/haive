import { eq, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import {
  sumCustomToolCalls,
  sumIntegrationCalls,
  type CallOutcomeCounts,
  type CustomToolCallCount,
  type IntegrationCallCount,
} from '@haive/shared/stats';

/** A task's call log, merged: `byStep` by task_steps.id, `all` with the rows no step owns. */
export interface CallGroups<T> {
  byStep: Map<string, T[]>;
  all: T[];
}

function groupCalls<T extends CallOutcomeCounts>(
  rows: Array<{ taskStepId: string | null; entry: T }>,
  sum: (lists: T[][]) => T[],
): CallGroups<T> {
  const lists = new Map<string, T[]>();
  for (const { taskStepId, entry } of rows) {
    if (taskStepId === null) continue;
    const list = lists.get(taskStepId);
    if (list) list.push(entry);
    else lists.set(taskStepId, [entry]);
  }
  return {
    byStep: new Map([...lists].map(([stepRowId, list]) => [stepRowId, sum([list])])),
    all: sum([rows.map((row) => row.entry)]),
  };
}

const oneOutcome = (outcome: keyof CallOutcomeCounts, n: number): CallOutcomeCounts => ({
  ok: 0,
  refused: 0,
  error: 0,
  running: 0,
  [outcome]: n,
});

export async function loadCustomToolCalls(
  db: Database,
  taskId: string,
): Promise<CallGroups<CustomToolCallCount>> {
  const calls = schema.customToolCalls;
  const rows = await db
    .select({
      taskStepId: calls.taskStepId,
      tool: calls.tool,
      action: calls.action,
      outcome: calls.outcome,
      n: sql<number>`count(*)::int`,
    })
    .from(calls)
    .where(eq(calls.taskId, taskId))
    .groupBy(calls.taskStepId, calls.tool, calls.action, calls.outcome);
  return groupCalls(
    rows.map((r) => ({
      taskStepId: r.taskStepId,
      entry: { tool: r.tool, action: r.action, ...oneOutcome(r.outcome, r.n) },
    })),
    sumCustomToolCalls,
  );
}

export async function loadIntegrationCalls(
  db: Database,
  taskId: string,
): Promise<CallGroups<IntegrationCallCount>> {
  const calls = schema.integrationCalls;
  const rows = await db
    .select({
      taskStepId: calls.taskStepId,
      providerId: calls.providerId,
      tool: calls.tool,
      access: calls.access,
      outcome: calls.outcome,
      n: sql<number>`count(*)::int`,
    })
    .from(calls)
    .where(eq(calls.taskId, taskId))
    .groupBy(calls.taskStepId, calls.providerId, calls.tool, calls.access, calls.outcome);
  return groupCalls(
    rows.map((r) => ({
      taskStepId: r.taskStepId,
      entry: {
        providerId: r.providerId,
        tool: r.tool,
        access: r.access,
        ...oneOutcome(r.outcome, r.n),
      },
    })),
    sumIntegrationCalls,
  );
}

/** Call rows both brokers logged for the task, those with no step and replaced runs included. */
export async function loadLoggedCallCount(
  db: Database,
  taskId: string,
): Promise<{ logged: number; running: number }> {
  const custom = schema.customToolCalls;
  const integration = schema.integrationCalls;
  // The two outcome enums are different types, which a union cannot match.
  const calls = unionAll(
    db
      .select({ id: custom.id, outcome: sql<string>`${custom.outcome}::text`.as('outcome') })
      .from(custom)
      .where(eq(custom.taskId, taskId)),
    db
      .select({
        id: integration.id,
        outcome: sql<string>`${integration.outcome}::text`.as('outcome'),
      })
      .from(integration)
      .where(eq(integration.taskId, taskId)),
  ).as('calls');
  const [row] = await db
    .select({
      logged: sql<number>`count(*)::int`,
      running: sql<number>`(count(*) filter (where ${calls.outcome} = 'running'))::int`,
    })
    .from(calls);
  return { logged: row?.logged ?? 0, running: row?.running ?? 0 };
}
