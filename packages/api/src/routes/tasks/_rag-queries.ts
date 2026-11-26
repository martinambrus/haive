import { and, count, eq, gte, lte, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { getDb } from '../../db.js';

/** The panel's historical attribution: task + inclusive step run window.
 *  Invocation bindings are credential proof and do not change these statistics. */
export function stepRagQueryWindow(taskId: string, startedAt: Date | AnyColumn, end: Date | SQL) {
  return and(
    eq(schema.ragQueryLog.taskId, taskId),
    gte(schema.ragQueryLog.createdAt, startedAt),
    lte(schema.ragQueryLog.createdAt, end),
  );
}

/** One grouped read for the task, keyed by row id so fix rounds stay separate.
 *  NULL starts match no query; a missing group is an explicit zero. */
export async function loadStepRagQueryCounts(
  db: ReturnType<typeof getDb>,
  taskId: string,
  now = new Date(),
): Promise<Map<string, number>> {
  const rows = await db
    .select({ stepRowId: schema.taskSteps.id, ragQueryCount: count(schema.ragQueryLog.id) })
    .from(schema.taskSteps)
    .innerJoin(
      schema.ragQueryLog,
      stepRagQueryWindow(
        taskId,
        schema.taskSteps.startedAt,
        sql`coalesce(${schema.taskSteps.endedAt}, ${now.toISOString()})`,
      ),
    )
    .where(eq(schema.taskSteps.taskId, taskId))
    .groupBy(schema.taskSteps.id);
  return new Map(rows.map((row) => [row.stepRowId, row.ragQueryCount]));
}
