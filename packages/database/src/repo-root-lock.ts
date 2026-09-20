import { sql } from 'drizzle-orm';
import type { Database } from './index.js';

// Transaction handle type (the callback arg of Database.transaction). Mirrors dag-reset.ts,
// which is the other helper both the api and the worker call.
type DbHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The lock's namespace. Two-int form (`hashtext(a), hashtext(b)`) rather than the single-bigint
 *  form `plan/mirror.ts` uses for ITS per-repository lock: Postgres keeps those in separate
 *  advisory lock spaces, so the two can never collide on the same repository however the hashes
 *  land. `auth.ts` takes the same two-int shape for the first-admin bootstrap. */
const LOCK_NAMESPACE = 'haive_repo_root';

/** Postgres compares `uuid` values by VALUE, so an id spelled with uppercase hex still selects the
 *  row — while `hashtext` compares BYTES and would answer a different lock. The api takes its
 *  repository id straight from the URL, so the two sides only agree if the key is normalised. */
function lockKey(repositoryId: string): string {
  return repositoryId.trim().toLowerCase();
}

/**
 * Serialise everything that writes a repository's ROOT tree, across processes.
 *
 * Two writers exist and neither can see the other: the api's onboarding-artifact reset, which
 * walks the root deleting and quarantining files, and a worker task job, whose steps write
 * `.claude/`, the per-CLI agent and skill directories and the knowledge base. The reset refuses
 * while a run is LIVE, but that refusal is a read — a task revived immediately after it lands its
 * files in the tree the reset is midway through walking.
 *
 * Transaction-scoped on purpose, like every other advisory lock in this repo except the migration
 * runner (see `migrate/lock.ts` for why that one is different): it releases when the caller's
 * transaction ends, including when the process dies, so a crashed reset cannot wedge a repository
 * shut. That also means the caller must HOLD its transaction for as long as the exclusion is
 * needed — for the reset, the whole handler including the filesystem walk.
 *
 * One function in one place because two packages must hash the SAME string. A second copy that
 * drifted would take a different lock, which is not a visible failure: every call still returns
 * successfully and the mutual exclusion is simply gone.
 */
export async function lockRepositoryRoot(
  db: Database | DbHandle,
  repositoryId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_NAMESPACE}), hashtext(${lockKey(repositoryId)}))`,
  );
}

/**
 * Take the same lock only if it is free. Returns false when someone already holds it.
 *
 * The worker's gate uses this to tell an uncontended pickup — every job on every install that
 * never resets — from one that is about to wait several seconds, so the wait can be named in the
 * log instead of looking like a hang. It is NOT a substitute for the blocking form: a caller that
 * gets false must still wait, or it would run exactly when it must not.
 */
export async function tryLockRepositoryRoot(
  db: Database | DbHandle,
  repositoryId: string,
): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_NAMESPACE}), hashtext(${lockKey(repositoryId)})) AS locked`,
  )) as unknown as Array<{ locked: boolean }>;
  return rows[0]?.locked === true;
}
