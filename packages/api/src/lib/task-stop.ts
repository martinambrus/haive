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

/** A failed task's latest `task.stopped`, when it failed the task: its `failedAt` is `completedAt`. */
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
  if (!event) return null;
  const { reason, moduleId, failedAt } = event.payload ?? {};
  if (typeof reason !== 'string') return null;
  const { completedAt } = task;
  const isCause =
    failedAt === undefined
      ? completedAt === null || event.createdAt >= completedAt
      : typeof failedAt === 'string' &&
        completedAt !== null &&
        Date.parse(failedAt) === completedAt.getTime();
  if (!isCause) return null;
  return { reason, moduleId: typeof moduleId === 'string' ? moduleId : null };
}
