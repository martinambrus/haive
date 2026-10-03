import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

export const OPEN_PLAN_TASK_STATES = [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
] as const;

/** Advisories address a node through metadata, not an implements/touched link:
 * researching a question neither implements it nor changes its code. */
export async function loadOpenPlanAdvisories(db: Pick<Database, 'select'>, repositoryId: string) {
  const rows = await db
    .select({
      taskId: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      type: schema.tasks.type,
      createdAt: schema.tasks.createdAt,
      metadata: schema.tasks.metadata,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'advisory'),
        inArray(schema.tasks.status, [...OPEN_PLAN_TASK_STATES]),
      ),
    );
  return rows.flatMap(({ metadata, ...task }) => {
    const nodeId = metadata?.planNodeId;
    return typeof nodeId === 'string' ? [{ ...task, nodeId }] : [];
  });
}
