import { sql } from 'drizzle-orm';
import { isLockNotAvailable } from '@haive/database';
import type { DbOrTx } from './apply-patch.js';
import { PlanPatchError } from './errors.js';

export const PLAN_PATCH_LOCK_TIMEOUT_MS = 1_000;

/**
 * Before any plan read or row lock: moving a subtree must exclude a child insert
 * that would otherwise keep its parent's old materialised path. Held until the
 * OUTER transaction ends, including when the applier runs under a savepoint.
 *
 * Callers may already hold a mining-row claim, the repository task-creation key
 * or the mirror advisory lock. A patch never takes those locks, and takes its
 * repository KEY SHARE, plan rows and mirror-state row only after this lock.
 * Mirror writers take this lock before any row mutation too.
 *
 * The bound covers acquiring this advisory lock only; subsequent writes retain
 * the database's usual lock timeout, as in the API's boundedLockWait.
 */
export async function lockPlanPatch(tx: DbOrTx, repositoryId: string): Promise<void> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${PLAN_PATCH_LOCK_TIMEOUT_MS}ms'`));
  try {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`plan-patch:${repositoryId}`}, 0))`,
    );
  } catch (err) {
    if (!isLockNotAvailable(err)) throw err;
    throw new PlanPatchError('busy', 'The plan is busy. Try again.');
  }
  await tx.execute(sql.raw('SET LOCAL lock_timeout = DEFAULT'));
}
