import {
  CheckoutUnavailableError,
  assertCheckoutMutationOwner,
  requireCheckoutAccess,
  withCheckoutMutation,
} from '@haive/shared/checkout-access';
import type { RootClaimHandle } from '@haive/database';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import { schema, withSettledTransaction } from '@haive/database';
import { linkRepoRemoteRequestSchema, logger } from '@haive/shared';
import { redactEditableGitUrl } from '@haive/shared/schemas';
import { getDb, withFreshDatabase } from '../db.js';
import { HttpError } from '../context.js';
import { boundedLockWait } from './repository-busy.js';
import { gitFailureText, relinkGit, verifyRelinkCheckout } from './relink-git.js';

// Only trusted database intent authorizes reconciliation; repository files are untrusted.
export const REMOTE_SWEEP_BATCH = 25;
export const REMOTE_SWEEP_INTERVAL_MS = 30_000;
export const REMOTE_SKIP_LOG_INTERVAL_MS = 300_000;

// Relinks in this process whose Git writes may still be running. A dropped database
// connection releases the row lock before such a write finishes, so the lock alone cannot
// keep the sweep from repairing and clearing an intent a later write then contradicts.
const relinkWriters = new Map<string, number>();

/** Fences the sweep off a repository until the returned call; a relink holds it across its Git. */
export function beginRelinkWriter(id: string): () => void {
  relinkWriters.set(id, (relinkWriters.get(id) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (relinkWriters.get(id) ?? 1) - 1;
    if (left > 0) relinkWriters.set(id, left);
    else relinkWriters.delete(id);
  };
}

/** Commit intent separately before the relink transaction or any Git mutation. */
export async function markRemoteIntent(id: string, userId: string) {
  return withFreshDatabase((db) =>
    db.transaction(async (tx) => {
      const [repo] = await boundedLockWait(tx, () =>
        tx
          .select()
          .from(schema.repositories)
          .where(and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)))
          .for('no key update'),
      );
      if (!repo) throw new HttpError(404, 'Repository not found');
      const token = randomUUID();
      await tx
        .update(schema.repositories)
        .set({ remoteRelinkIntent: token })
        .where(eq(schema.repositories.id, id));
      // Replace the token, but inherit a predecessor's unresolved need for repair.
      return { token, created: !repo.remoteRelinkIntent };
    }),
  );
}

export async function clearRemoteIntent(
  id: string,
  token: string,
  executor?: Pick<ReturnType<typeof getDb>, 'update'>,
): Promise<void> {
  const clear = (db: Pick<ReturnType<typeof getDb>, 'update'>) =>
    db
      .update(schema.repositories)
      .set({ remoteRelinkIntent: null })
      .where(
        and(eq(schema.repositories.id, id), eq(schema.repositories.remoteRelinkIntent, token)),
      );
  if (executor) {
    await clear(executor);
    return;
  }
  await withFreshDatabase((db) => db.transaction((tx) => boundedLockWait(tx, () => clear(tx))));
}

/** Driver, socket and PostgreSQL connection/shutdown errors, including Drizzle causes. */
export function isRemoteConnectionError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const pending = [err];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const error = value as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (
      typeof error.code === 'string' &&
      (error.code.startsWith('CONNECTION_') ||
        /^08[0-9A-Z]{3}$/.test(error.code) ||
        [
          'ECONNRESET',
          'ECONNREFUSED',
          'EPIPE',
          'ETIMEDOUT',
          'EHOSTUNREACH',
          'ENETUNREACH',
          '57P01',
          '57P02',
          '57P03',
          '40003',
        ].includes(error.code))
    )
      return true;
    pending.push(error.cause, ...(Array.isArray(error.errors) ? error.errors : []));
  }
  return false;
}

/** A fresh locked read is the authority, never the route's pre-transaction snapshot.
 *  `skipLocked` (the sweep) passes over a row a relink holds instead of waiting for it: that
 *  request settles its own intent after it releases the row, and the next tick sees the rest. */
export async function reconcileRemote(
  id: string,
  userId: string,
  { skipLocked = false, owner }: { skipLocked?: boolean; owner?: RootClaimHandle } = {},
): Promise<'locked' | 'fenced' | 'checkout' | undefined> {
  const run = async (checkoutOwner: RootClaimHandle) =>
    withFreshDatabase(async (db) => {
      return withSettledTransaction(db, async (tx) => {
        const [repo] = await boundedLockWait(tx, () =>
          tx
            .select()
            .from(schema.repositories)
            .where(and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)))
            .for('no key update', skipLocked ? { skipLocked: true } : undefined),
        );
        // SKIP LOCKED cannot distinguish a held row from a delete. An ordinary MVCC
        // read does not wait for its writer, and avoids calling a vanished row locked.
        if (!repo) {
          if (skipLocked) {
            const pending = await tx.query.repositories.findFirst({
              where: and(
                eq(schema.repositories.id, id),
                eq(schema.repositories.userId, userId),
                isNotNull(schema.repositories.remoteRelinkIntent),
              ),
              columns: { id: true },
            });
            if (pending) return 'locked' as const;
          }
          return;
        }
        if (!repo.remoteRelinkIntent) return;
        // A relink whose connection dropped may still be writing Git; it reconciles itself.
        if (skipLocked && relinkWriters.has(id)) return 'fenced' as const;
        await requireCheckoutAccess(tx, id, {
          mode: 'mutation',
          owner: checkoutOwner,
          availability: 'repair',
        });
        const root = repo.storagePath ?? repo.localPath;
        if (!root) throw new Error('Repository has no path for remote reconciliation');
        await verifyRelinkCheckout(root);
        // A legacy stored URL may still contain credentials. Never copy those to Git.
        let remote: string | null = null;
        if (repo.remoteUrl !== null) {
          const parsed = linkRepoRemoteRequestSchema.safeParse({
            remoteUrl: redactEditableGitUrl(repo.remoteUrl),
          });
          if (!parsed.success) throw new Error('Saved remote needs repair before reconciliation');
          remote = parsed.data.remoteUrl;
        }
        const git = (args: string[]) => {
          assertCheckoutMutationOwner(checkoutOwner);
          return relinkGit(root, args);
        };
        if (remote === null) {
          const removed = await git(['remote', 'remove', 'origin']);
          if (!removed.ok && removed.code !== 2)
            throw new Error(`Could not reconcile origin: ${gitFailureText(removed)}`);
        } else {
          const added = await git(['remote', 'add', 'origin', remote]);
          if (!added.ok && added.code !== 3)
            throw new Error(`Could not reconcile origin: ${gitFailureText(added)}`);
          if (!added.ok) {
            const cleared = await git([
              'config',
              '--local',
              '--unset-all',
              'remote.origin.pushurl',
            ]);
            if (!cleared.ok && cleared.code !== 5)
              throw new Error(`Could not reconcile push URLs: ${gitFailureText(cleared)}`);
            const updated = await git([
              'config',
              '--local',
              '--replace-all',
              'remote.origin.url',
              remote,
            ]);
            if (!updated.ok)
              throw new Error(`Could not reconcile remote URL: ${gitFailureText(updated)}`);
          }
        }
        await clearRemoteIntent(id, repo.remoteRelinkIntent, tx);
        logger.info({ repositoryId: id }, 'reconciled repository remote to the database');
      });
    });
  if (owner) return run(owner);
  // Do not claim another tenant's row or turn a deleted repository into a checkout failure.
  const repo = await getDb().query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: { id: true },
  });
  if (!repo) return;
  try {
    return await withCheckoutMutation(getDb(), id, userId, run, 'repair');
  } catch (err) {
    if (skipLocked && err instanceof CheckoutUnavailableError) return 'checkout';
    throw err;
  }
}

/** One bounded page per tick, rotating through IDs. No request-pool connection spans Git. */
export function startRemoteReconcileSweep({
  batchSize = REMOTE_SWEEP_BATCH,
  intervalMs = REMOTE_SWEEP_INTERVAL_MS,
  skipLogIntervalMs = REMOTE_SKIP_LOG_INTERVAL_MS,
  schedule = setTimeout,
} = {}): () => void {
  let cursor: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout;
  const skipLoggedAt = new Map<string, number>();
  const checkoutHolds = new Set<string>();
  const seen = new Set<string>();
  const tick = async () => {
    // Retain only this log interval's skips, bounded by the sweep's page size/rate.
    const expired = Date.now() - skipLogIntervalMs;
    for (const [id, at] of skipLoggedAt) {
      if (at <= expired) skipLoggedAt.delete(id);
    }
    try {
      const repos = await getDb().query.repositories.findMany({
        where: and(
          isNotNull(schema.repositories.remoteRelinkIntent),
          cursor ? gt(schema.repositories.id, cursor) : undefined,
        ),
        orderBy: [asc(schema.repositories.id)],
        limit: batchSize,
        columns: { id: true, userId: true },
      });
      cursor = repos.length === batchSize ? repos.at(-1)!.id : undefined;
      for (const repo of repos) {
        if (stopped) break;
        seen.add(repo.id);
        try {
          const reason = await reconcileRemote(repo.id, repo.userId, { skipLocked: true });
          if (reason !== 'checkout') checkoutHolds.delete(repo.id);
          if (reason === 'checkout') {
            if (!checkoutHolds.has(repo.id)) {
              checkoutHolds.add(repo.id);
              logger.info({ repositoryId: repo.id, reason }, 'remote reconciliation skipped');
            }
            continue;
          }
          if (!reason) skipLoggedAt.delete(repo.id);
          if (reason && !skipLoggedAt.has(repo.id)) {
            skipLoggedAt.set(repo.id, Date.now());
            logger.info({ repositoryId: repo.id, reason }, 'remote reconciliation skipped');
          }
        } catch (err) {
          logger.warn({ err, repositoryId: repo.id }, 'remote state reconciliation deferred');
        }
      }
      if (cursor === undefined) {
        for (const id of checkoutHolds) if (!seen.has(id)) checkoutHolds.delete(id);
        seen.clear();
      }
    } catch (err) {
      logger.warn({ err }, 'remote reconciliation sweep deferred');
    } finally {
      if (!stopped) {
        timer = schedule(() => {
          void tick();
        }, intervalMs);
        timer.unref();
      }
    }
  };
  timer = schedule(() => {
    void tick();
  }, 0);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
