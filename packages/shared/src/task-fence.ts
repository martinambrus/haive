import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';

/** Statuses a task never comes back from. Cancel is the user's final word and completion is
 *  done; only `failed` is revivable (retry / allowance auto-resume). Every write that could flip
 *  a task back to running/waiting excludes these, so a stale job cannot raise the dead. */
export const TERMINAL_TASK_STATUSES = ['cancelled', 'completed'] as const;

/** A job's write to the task under the epoch the job holds. It lands only while the task is still
 *  at that epoch and has not failed since: a Stop fails a task without moving the epoch. A job may
 *  revive a task that was already failed when it picked it up (`reviveFailed`), which the pickup
 *  guard allows only for an answer to a form still parked, since answering it reopens the task. */
export interface TaskFence {
  epoch: number;
  reviveFailed?: boolean;
}

/** `held`: new work is held, so a failed task is not written, whatever the fence allows.
 * `settled` is the inverse admission for destructive settlement members. Use it in a
 * SELECT FOR NO KEY UPDATE, holding the row through removal; Retry writes that same row.
 * These sections must not acquire step/run rows, repository locks or CLI auth locks. */
export function taskWriteTarget(
  taskId: string,
  fence?: TaskFence | { settled: true; epoch?: number },
  held = false,
) {
  if (fence && 'settled' in fence) {
    return and(
      eq(schema.tasks.id, taskId),
      inArray(schema.tasks.status, [...TERMINAL_TASK_STATUSES, 'failed']),
      ...(fence.epoch === undefined ? [] : [eq(schema.tasks.orchestrationEpoch, fence.epoch)]),
    );
  }
  const refused = held || (fence !== undefined && !fence.reviveFailed);
  return and(
    eq(schema.tasks.id, taskId),
    notInArray(schema.tasks.status, [
      ...TERMINAL_TASK_STATUSES,
      ...(refused ? (['failed'] as const) : []),
    ]),
    ...(fence ? [eq(schema.tasks.orchestrationEpoch, fence.epoch)] : []),
  );
}

/** Bound the entire settlement section, including time spent waiting on external IO.
 * PostgreSQL 18 terminates the transaction's connection and releases its locks; postgres.js
 * races the callback against that closed lease, so a hung Docker/Redis await rejects too. */
export const TASK_SETTLEMENT_TIMEOUT_MS = 60_000;
export async function setTaskSettlementTimeout(
  tx: DbTx,
  timeoutMs = TASK_SETTLEMENT_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error('Invalid task settlement transaction timeout');
  await tx.execute(sql.raw(`SET LOCAL transaction_timeout = '${timeoutMs}ms'`));
}

/** postgres.js may reject a transaction while its callback is still awaiting external IO.
 * End the callback's authority on every exit, including a connection closed by the server.
 * Check this signal immediately before each destructive call, including nested helpers. */
export async function withTaskSettlementTransaction<T>(
  db: Database | DbTx,
  section: (tx: DbTx, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  try {
    return await db.transaction((tx) => section(tx, controller.signal));
  } finally {
    controller.abort(new Error('Task settlement transaction ended'));
  }
}
