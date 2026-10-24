import { and, eq, isNull } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema, type DbTx } from '@haive/database';
import { TASK_JOB_NAMES, logger, type TaskJobPayload } from '@haive/shared';
import { boundedLockWait } from './repository-busy.js';
import type { getDb } from '../db.js';
import { getTaskQueue } from '../queues.js';

export class MissingTaskAttachmentsError extends Error {
  constructor(
    readonly landed: number,
    readonly expected: number,
  ) {
    super('Some expected attachments have not landed');
  }
}

/** Moves a `created` task to `queued`, which the stalled re-driver starts when its START is lost.
 *  Called after every write that can fail, since a task left `created` is one nothing starts.
 *  Returns the row, or undefined when the task was no longer `created` or is dead. */
export async function markQueuedForStart(
  db: ReturnType<typeof getDb> | DbTx,
  taskId: string,
  confirmMissingAttachments = false,
) {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({
        repositoryId: schema.tasks.repositoryId,
        expectedAttachmentCount: schema.tasks.expectedAttachmentCount,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    // A queued task holds the checkout, so its start waits out a move that holds this lock.
    const repositoryId = task?.repositoryId;
    if (repositoryId) await boundedLockWait(tx, () => lockRepositoryTasksKey(tx, repositoryId));
    // Unrecorded counts keep the ordinary create/start path. For a recorded count, serialize
    // starts before checking it so an already-started task never conflicts over missing files.
    if (task?.expectedAttachmentCount != null) {
      const [current] = await tx
        .select({ status: schema.tasks.status, deadAt: schema.tasks.deadAt })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .for('update');
      if (!current || current.status !== 'created' || current.deadAt != null) return undefined;
      const expected = task.expectedAttachmentCount;
      if (expected > 0 && !confirmMissingAttachments) {
        const landed = await tx
          .select({ id: schema.taskAttachments.id })
          .from(schema.taskAttachments)
          .where(
            and(
              eq(schema.taskAttachments.taskId, taskId),
              isNull(schema.taskAttachments.expandedFromId),
            ),
          )
          .limit(expected);
        if (landed.length < expected)
          throw new MissingTaskAttachmentsError(landed.length, expected);
      }
    }
    const [queued] = await tx
      .update(schema.tasks)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.status, 'created'),
          isNull(schema.tasks.deadAt),
        ),
      )
      .returning();
    return queued;
  });
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
