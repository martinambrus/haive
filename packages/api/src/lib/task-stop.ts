import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
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

interface StopEvent {
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

const STOP_EVENTS_READ = 50;

function stopThatFailed(events: StopEvent[], completedAt: Date | null): TaskStopDetail | null {
  // A later stop of the already failed task records `failedAt: null` and must not hide the one that failed it.
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

/** The newest `task.stopped` that failed this failed task: its `failedAt` is `completedAt`. */
export async function loadTaskStop(
  db: Pick<Database, 'select'>,
  task: StopFields,
): Promise<TaskStopDetail | null> {
  if (task.status !== 'failed') return null;
  const events = await db
    .select({ payload: schema.taskEvents.payload, createdAt: schema.taskEvents.createdAt })
    .from(schema.taskEvents)
    .where(
      and(eq(schema.taskEvents.taskId, task.id), eq(schema.taskEvents.eventType, 'task.stopped')),
    )
    .orderBy(desc(schema.taskEvents.createdAt))
    .limit(STOP_EVENTS_READ);
  return stopThatFailed(events, task.completedAt);
}

/** `loadTaskStop` for a page of tasks in one query: a task nothing stopped has no entry. */
export async function loadTaskStops(
  db: Pick<Database, 'select'>,
  tasks: StopFields[],
): Promise<Map<string, TaskStopDetail>> {
  const stops = new Map<string, TaskStopDetail>();
  const failed = tasks.filter((task) => task.status === 'failed');
  if (failed.length === 0) return stops;
  const stopped = db
    .select({
      taskId: schema.taskEvents.taskId,
      payload: schema.taskEvents.payload,
      createdAt: schema.taskEvents.createdAt,
      place: sql<number>`row_number() over (
        partition by ${schema.taskEvents.taskId} order by ${schema.taskEvents.createdAt} desc
      )`.as('place'),
    })
    .from(schema.taskEvents)
    .where(
      and(
        inArray(
          schema.taskEvents.taskId,
          failed.map((task) => task.id),
        ),
        eq(schema.taskEvents.eventType, 'task.stopped'),
      ),
    )
    .as('stopped');
  const events = await db
    .select({ taskId: stopped.taskId, payload: stopped.payload, createdAt: stopped.createdAt })
    .from(stopped)
    .where(lte(stopped.place, STOP_EVENTS_READ))
    .orderBy(desc(stopped.createdAt));
  const byTask = new Map<string, StopEvent[]>();
  for (const event of events) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
  }
  for (const task of failed) {
    const stop = stopThatFailed(byTask.get(task.id) ?? [], task.completedAt);
    if (stop) stops.set(task.id, stop);
  }
  return stops;
}
