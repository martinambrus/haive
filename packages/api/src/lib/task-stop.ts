import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

export interface TaskStopDetail {
  reason: string;
  moduleId: string | null;
}

interface StopFields {
  id: string;
  status: string;
  completedAt: Date | null;
}

/** A failed task's latest `task.stopped`, unless the task failed again after it (a Retry between). */
export async function loadTaskStop(
  db: Pick<Database, 'select'>,
  task: StopFields,
): Promise<TaskStopDetail | null> {
  if (task.status !== 'failed') return null;
  const [event] = await db
    .select({ payload: schema.taskEvents.payload, createdAt: schema.taskEvents.createdAt })
    .from(schema.taskEvents)
    .where(
      and(eq(schema.taskEvents.taskId, task.id), eq(schema.taskEvents.eventType, 'task.stopped')),
    )
    .orderBy(desc(schema.taskEvents.createdAt))
    .limit(1);
  if (!event || (task.completedAt !== null && event.createdAt < task.completedAt)) return null;
  const { reason, moduleId } = event.payload ?? {};
  if (typeof reason !== 'string') return null;
  return { reason, moduleId: typeof moduleId === 'string' ? moduleId : null };
}
