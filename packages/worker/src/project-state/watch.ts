import { and, asc, eq, gt, isNotNull, or, sql } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import { readNamedCheckout } from '../repo/checkout-head.js';
import { syncPlanFromCheckout } from '../plan/sync-checkout.js';
import { PlanMirrorHeldError } from '../plan/mirror.js';
import { refreshProjectState } from './refresh.js';
import { readCheckout } from './sync.js';
import { lockProjectState, ProjectStateMovedError, recoverProjectStateWrite } from './write.js';
import { admitWatchedCheckout } from './watch-admission.js';

export type CheckoutWatchResult =
  'disabled' | 'held' | 'refused' | 'absent' | 'unchanged' | 'synced';

/** Observe only this checkout: never fetch, pull, change branch or visit a folder import's source. */
export async function watchCheckout(
  db: Database,
  repositoryId: string,
): Promise<CheckoutWatchResult> {
  if (!(await configService.getBoolean(CONFIG_KEYS.PROJECT_STATE_SYNC_ENABLED, true)))
    return 'disabled';
  const [repo] = await db
    .select({
      storagePath: schema.repositories.storagePath,
      localPath: schema.repositories.localPath,
      status: schema.repositories.status,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId));
  const repoPath = repo?.storagePath ?? repo?.localPath;
  if (!repoPath || repo?.status !== 'ready') return 'held';
  const head = await readNamedCheckout(repoPath);
  if (!head) return 'held';
  try {
    // Public recovery and refresh own their ordered transactions. Never call either under our lock.
    await recoverProjectStateWrite(db, repositoryId, repoPath, head);
    const observed = await db.transaction(async (tx) => {
      await lockRepositoryTasksKey(tx, repositoryId);
      await lockProjectState(tx, repositoryId);
      if (!(await admitWatchedCheckout(tx, repositoryId, repoPath, head))) return 'held' as const;
      const checkout = await readCheckout(repoPath);
      if (checkout.kind === 'refused') {
        await tx
          .update(schema.projectStateSync)
          .set({ lastError: checkout.reason, updatedAt: new Date() })
          .where(
            and(
              eq(schema.projectStateSync.repositoryId, repositoryId),
              sql`${schema.projectStateSync.lastError} IS DISTINCT FROM ${checkout.reason}`,
            ),
          );
        return 'refused' as const;
      }
      if (checkout.kind === 'absent') return 'absent' as const;
      const [state] = await tx
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, repositoryId));
      const [outbox] = await tx
        .select()
        .from(schema.projectStateOutbox)
        .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
      // Hash every byte on every pass. Size/mtime cannot prove a hand edit did not happen.
      // Recheck a diagnosed record through the common importer, even when someone restored its
      // last accepted bytes: a prior refusal must not remain after those bytes are valid again.
      return state?.syncedHash === checkout.hash &&
        state.lastError === null &&
        !outbox?.writeIntent &&
        (!outbox || outbox.writtenRevision >= outbox.revision)
        ? ('unchanged' as const)
        : ('changed' as const);
    });
    if (observed === 'held') return 'held';
    let result: CheckoutWatchResult = observed === 'changed' ? 'synced' : observed;
    if (observed === 'changed' && !(await refreshProjectState(db, repositoryId, head)))
      result = 'held';
    if (result === 'synced' || result === 'unchanged') {
      // A writer invalidates HEAD: it knows output bytes, not which named commit was observed.
      // Stamp only its accepted complete raw hash, re-read under admission after all public calls.
      const stamped = await db.transaction(async (tx) => {
        await lockRepositoryTasksKey(tx, repositoryId);
        await lockProjectState(tx, repositoryId);
        if (!(await admitWatchedCheckout(tx, repositoryId, repoPath, head))) return false;
        const [writing] = await tx
          .select({ intent: schema.projectStateOutbox.writeIntent })
          .from(schema.projectStateOutbox)
          .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
        if (writing?.intent) return false;
        const checkout = await readCheckout(repoPath);
        if (checkout.kind !== 'record') return false;
        const [state] = await tx
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, repositoryId));
        if (
          !state ||
          state.syncedHash !== checkout.hash ||
          !(await admitWatchedCheckout(tx, repositoryId, repoPath, head))
        )
          return false;
        if (state.syncedHead !== head.sha)
          await tx
            .update(schema.projectStateSync)
            .set({ syncedHead: head.sha })
            .where(eq(schema.projectStateSync.repositoryId, repositoryId));
        return true;
      });
      if (!stamped) result = 'held';
    }
    // A plan can change without HEAD or state changing. Its own import has a separate lock and stamp.
    await syncPlanFromCheckout(db, repositoryId, repoPath, head);
    return result;
  } catch (err) {
    if (err instanceof ProjectStateMovedError || err instanceof PlanMirrorHeldError) return 'held';
    throw err;
  }
}

/** Keyset pages cover every eligible repo, including those with no outbox or failed first import.
 * A failed/held/capped cancellation does not remove a repo from future passes. */
export async function sweepCheckoutRepositories(
  db: Database,
  enqueue: (repositoryId: string) => Promise<unknown>,
): Promise<number> {
  if (!(await configService.getBoolean(CONFIG_KEYS.PROJECT_STATE_SYNC_ENABLED, true))) return 0;
  let after: string | undefined;
  let queued = 0;
  for (;;) {
    const rows = await db
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .where(
        and(
          eq(schema.repositories.status, 'ready'),
          or(isNotNull(schema.repositories.storagePath), isNotNull(schema.repositories.localPath)),
          after ? gt(schema.repositories.id, after) : undefined,
        ),
      )
      .orderBy(asc(schema.repositories.id))
      .limit(100);
    for (const { id } of rows) {
      try {
        await enqueue(id);
        queued++;
      } catch (err) {
        logger.warn(
          { err, repositoryId: id },
          'checkout observation enqueue failed; next sweep will retry',
        );
      }
    }
    if (rows.length < 100) return queued;
    after = rows.at(-1)!.id;
  }
}
