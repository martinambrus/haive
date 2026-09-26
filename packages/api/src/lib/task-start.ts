import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { TASK_JOB_NAMES, logger, type TaskJobPayload } from '@haive/shared';
import type { getDb } from '../db.js';
import { getTaskQueue } from '../queues.js';

/** Moves a `created` task to `queued`, which the stalled re-driver starts when its START is lost.
 *  Called after every write that can fail, since a task left `created` is one nothing starts.
 *  Returns the row, or undefined when the task was no longer `created`. */
export async function markQueuedForStart(db: ReturnType<typeof getDb>, taskId: string) {
  const [queued] = await db
    .update(schema.tasks)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.status, 'created')))
    .returning();
  return queued;
}

/** Never throws: the task is `queued` already, so a START that could not be queued is the
 *  re-driver's to give. */
export async function enqueueStart(taskId: string, userId: string): Promise<void> {
  try {
    await getTaskQueue().add(TASK_JOB_NAMES.START, { taskId, userId } satisfies TaskJobPayload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  } catch (err) {
    logger.warn({ err, taskId }, 'task START enqueue failed; the stalled re-driver will start it');
  }
}
