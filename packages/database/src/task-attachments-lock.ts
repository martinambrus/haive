import { sql } from 'drizzle-orm';
import type { Database } from './index.js';

/** A transaction on the database handle, which is what every query inside a locked section runs on. */
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * How long a writer waits for another writer's section before giving up.
 *
 * The sections are short by rule — the longest is a folder delete removing its files one by one —
 * so a wait this long means a stuck holder rather than a slow one. Every waiter holds a pooled
 * connection while it waits, so an unbounded wait would starve the whole pool behind one task.
 */
export const TASK_ATTACHMENTS_LOCK_TIMEOUT_MS = 30_000;

/**
 * Run `fn` as the only writer of one task's attachments, across the api and the worker.
 *
 * A transaction-scoped advisory lock (the shape `plan/mirror.ts` uses per repository): it is taken
 * for the section and released by its end, so nothing has to release it and a crashed holder
 * cannot leave it behind. What it serialises is every write that changes WHICH files a task has —
 * an upload claiming a name, a delete removing rows and files, the expansion placing a tree, a
 * sidecar being written for a row — together with the manifest rewrite that follows each one.
 *
 * Three rules make it safe to hold:
 *
 * - Sections are SHORT. Never hold one across an HTTP stream or an archive extraction: the lock is
 *   held by a pooled connection, and both pools are `max: 10`.
 * - Everything inside goes through `tx`. A query on the pool waits for a connection the section may
 *   itself be starving, and it cannot see the section's own uncommitted writes.
 * - Never call anything that takes this lock on the POOL from inside a section — the second
 *   transaction would wait on the first forever. Handed a transaction, this nests as a savepoint on
 *   the same session, where the lock is re-entrant, so helpers that take it are safe to call with
 *   `tx`.
 *
 * A wait past {@link TASK_ATTACHMENTS_LOCK_TIMEOUT_MS} throws SQLSTATE 55P03
 * (`isLockNotAvailable`).
 */
export async function withTaskAttachmentsLock<T>(
  handle: Database | DbTx,
  taskId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return (handle as Database).transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${TASK_ATTACHMENTS_LOCK_TIMEOUT_MS}ms'`));
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`task-attachments:${taskId}`}, 0))`,
    );
    return fn(tx);
  });
}
