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

const STOP_EVENTS_READ = 50;

/** The newest `task.stopped` that failed this failed task: its `failedAt` is `completedAt`. */
export async function loadTaskStop(
  db: Pick<Database, 'select'>,
  task: StopFields,
): Promise<TaskStopDetail | null> {
  if (task.status !== 'failed') return null;
  // A later stop of the already failed task records `failedAt: null` and must not hide the one that failed it.
  const events = await db
    .select({ payload: schema.taskEvents.payload, createdAt: schema.taskEvents.createdAt })
    .from(schema.taskEvents)
    .where(
      and(eq(schema.taskEvents.taskId, task.id), eq(schema.taskEvents.eventType, 'task.stopped')),
    )
    .orderBy(desc(schema.taskEvents.createdAt))
    .limit(STOP_EVENTS_READ);
  const { completedAt } = task;
  for (const event of events) {
    const { reason, moduleId, failedAt } = event.payload ?? {};
    if (typeof reason !== 'string') continue;
    const isCause =
      failedAt === undefined
        ? completedAt === null || event.createdAt >= completedAt
        : typeof failedAt === 'string' &&
          completedAt !== null &&
          Date.parse(failedAt) === completedAt.getTime();
    if (isCause) return { reason, moduleId: typeof moduleId === 'string' ? moduleId : null };
  }
  return null;
}
