import type { Sql } from 'postgres';
import { emit } from './log.js';

/** One well-known key, hashed the way the rest of the repo hashes advisory-lock keys. */
const LOCK_KEY = 'haive:schema_migrations';

export class LockNotAcquiredError extends Error {}
export class LockLostError extends Error {}

/**
 * Take the migration lock for the whole run.
 *
 * SESSION-scoped (`pg_try_advisory_lock`), NOT `pg_advisory_xact_lock`. Every existing advisory
 * lock in this repo — `plan/mirror.ts`, `_global-kb-promote.ts`, `kb-author/01-enrich.ts` — uses
 * the transaction-scoped variant, so it is the reflex thing to copy here and it would be wrong:
 * the runner takes one transaction PER FILE, so a transaction-scoped lock would release after
 * the first file and leave every later one unprotected.
 *
 * Returns the backend pid holding it, which the caller re-asserts before each file. postgres.js
 * reconnects a dropped connection transparently, and the lock dies with its backend — so without
 * that re-check "two runners cannot race" is a claim rather than a guarantee, in exactly the
 * scenario where it matters.
 */
export async function acquireMigrationLock(sql: Sql, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [got] = await sql<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${LOCK_KEY})) AS locked`;
    if (got?.locked) {
      const [pid] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      return pid?.pid ?? 0;
    }
    if (Date.now() >= deadline) {
      throw new LockNotAcquiredError(await describeHolder(sql, timeoutMs));
    }
    emit('lock-wait', { reason: 'another migration holds the lock' });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** Name who is holding it. A hang with no explanation is the worst version of this failure. */
async function describeHolder(sql: Sql, timeoutMs: number): Promise<string> {
  try {
    const rows = await sql<{ pid: number; application_name: string; age: string }[]>`
      SELECT a.pid, a.application_name, (now() - a.query_start)::text AS age
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory'
         AND l.objid = (SELECT hashtext(${LOCK_KEY})::bigint & 4294967295)
       LIMIT 1`;
    const holder = rows[0];
    if (holder) {
      return `another migration is running (pid ${holder.pid}, ${holder.application_name}, running ${holder.age}); gave up after ${timeoutMs}ms`;
    }
  } catch {
    // Reporting the holder is a courtesy; failing to identify it must not replace the real error.
  }
  return `could not acquire the migration lock within ${timeoutMs}ms`;
}

/**
 * Prove the lock is still ours.
 *
 * A changed backend pid means postgres.js reconnected, which means the session lock was released
 * by the server when the old backend went away — and another runner may already hold it. There
 * is no safe way to continue, so this throws.
 */
export async function assertLockHeld(sql: Sql, expectedPid: number): Promise<void> {
  const [row] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  if (row?.pid !== expectedPid) {
    throw new LockLostError(
      `the connection was replaced mid-run (backend pid ${expectedPid} -> ${row?.pid}), so the ` +
        `migration lock is no longer held; stopping rather than racing another runner`,
    );
  }
}
