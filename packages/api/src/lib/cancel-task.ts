import { and, eq, notInArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { TASK_JOB_NAMES, type TaskJobPayload } from '@haive/shared';
import type { getDb } from '../db.js';
import { getTaskQueue } from '../queues.js';

type Db = ReturnType<typeof getDb>;
/** Accepts either the top-level db handle or the `tx` param drizzle yields
 *  inside `db.transaction(async (tx) => ...)`. PgTransaction shares the
 *  insert/update surface with PostgresJsDatabase but isn't structurally
 *  assignable (`$client` is missing on tx), so we derive the union from
 *  the transaction callback's argument type. */
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Mark a single task row as cancelled and append the activity event.
 *  Caller is responsible for enqueueing the BullMQ CANCEL job (via
 *  enqueueCancelJob) AFTER any surrounding transaction commits — enqueueing
 *  inside a transaction would queue work for state that may roll back. */
export async function cancelTaskRow(
  tx: DbOrTx,
  taskId: string,
  opts: { by: string; reason?: string },
): Promise<void> {
  const now = new Date();
  await tx
    .update(schema.tasks)
    .set({ status: 'cancelled', completedAt: now, updatedAt: now })
    .where(eq(schema.tasks.id, taskId));
  await tx.insert(schema.taskEvents).values({
    taskId,
    taskStepId: null,
    eventType: 'task.cancelled',
    payload: opts.reason ? { by: opts.by, reason: opts.reason } : { by: opts.by },
  });
}

/** Enqueue the worker-side cancel job that tears down sandboxes, terminal
 *  sessions, env images, and auth volumes for the cancelled task. Must be
 *  called AFTER the row update has committed. Idempotent on the worker side. */
export async function enqueueCancelJob(taskId: string, userId: string): Promise<void> {
  await getTaskQueue().add(TASK_JOB_NAMES.CANCEL, { taskId, userId } as TaskJobPayload, {
    removeOnComplete: 50,
    removeOnFail: 50,
  });
}

/** Find every non-terminal task pinned to the given repository for the given
 *  user and cancel each one (mark cancelled + append event). Used by the
 *  repo-delete handler so the schema's `set null` cascade does not orphan
 *  running tasks against a workdir that no longer exists. Returns the list
 *  of cancelled task ids so the caller can enqueue worker CANCEL jobs after
 *  the surrounding transaction commits. */
export async function cancelOpenTasksForRepo(
  tx: DbOrTx,
  repoId: string,
  userId: string,
): Promise<Array<{ id: string }>> {
  const open = await tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repoId),
        eq(schema.tasks.userId, userId),
        notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
      ),
    );
  for (const t of open) {
    await cancelTaskRow(tx, t.id, { by: userId, reason: 'repository_deleted' });
  }
  return open;
}
