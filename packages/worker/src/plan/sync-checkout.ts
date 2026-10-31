import type { NamedCheckout } from '../repo/checkout-head.js';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import {
  importPlanMirror,
  reconcilePlanFromCheckout,
  recordPlanMirrorError,
  recordPlanReconcileFailure,
} from './mirror.js';

/** Reads the checkout's plan.json in after a scan or a checkout move: a reconcile into a plan this install
 *  already has, an import into none. Whether a plan exists is read from the rows, not from the import: a
 *  malformed file fails the import before it checks, and would never reach the reconcile and its failure
 *  record. */
export async function syncPlanFromCheckout(
  db: Database,
  repositoryId: string,
  repoPath: string,
  expectedCheckout?: NamedCheckout,
): Promise<void> {
  const [ownPlan] = await db
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, repositoryId))
    .limit(1);
  if (ownPlan) {
    await reconcilePlanFromCheckout(db, repositoryId, repoPath, {
      requireStamp: true,
      expectedCheckout,
    }).catch(async (err: unknown) => {
      await recordPlanReconcileFailure(db, repositoryId, err).catch(() => undefined);
      throw err;
    });
    return;
  }
  const res = await importPlanMirror(db, repositoryId, repoPath, expectedCheckout);
  if (!res.imported && res.code === 'refused') {
    await recordPlanMirrorError(
      db,
      repositoryId,
      `Plan snapshot not imported: ${res.reason}`,
    ).catch(() => undefined);
    logger.info({ repositoryId, reason: res.reason }, 'plan mirror not imported');
  }
}
