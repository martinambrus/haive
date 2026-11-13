import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import { linkRepoRemoteRequestSchema, logger } from '@haive/shared';
import { redactEditableGitUrl } from '@haive/shared/schemas';
import { getDb, withFreshDatabase } from '../db.js';
import { HttpError } from '../context.js';
import { boundedLockWait } from './repository-busy.js';
import { gitFailureText, relinkGit, verifyRelinkCheckout } from './relink-git.js';

// Only trusted database intent authorizes reconciliation; repository files are untrusted.
export const REMOTE_SWEEP_BATCH = 25;
export const REMOTE_SWEEP_INTERVAL_MS = 30_000;

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
  { skipLocked = false }: { skipLocked?: boolean } = {},
): Promise<void> {
  await withFreshDatabase(async (db) => {
    await db.transaction(async (tx) => {
      const [repo] = await boundedLockWait(tx, () =>
        tx
          .select()
          .from(schema.repositories)
          .where(and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)))
          .for('no key update', skipLocked ? { skipLocked: true } : undefined),
      );
      // A delete won the lock (do not touch its former checkout), or a relink holds the row.
      if (!repo?.remoteRelinkIntent) return;
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
      const git = (args: string[]) => relinkGit(root, args);
      if (remote === null) {
        const removed = await git(['remote', 'remove', 'origin']);
        if (!removed.ok && removed.code !== 2)
          throw new Error(`Could not reconcile origin: ${gitFailureText(removed)}`);
      } else {
        const added = await git(['remote', 'add', 'origin', remote]);
        if (!added.ok && added.code !== 3)
          throw new Error(`Could not reconcile origin: ${gitFailureText(added)}`);
        if (!added.ok) {
          const cleared = await git(['config', '--local', '--unset-all', 'remote.origin.pushurl']);
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
}

/** One bounded page per tick, rotating through IDs. No request-pool connection spans Git. */
export function startRemoteReconcileSweep({
  batchSize = REMOTE_SWEEP_BATCH,
  intervalMs = REMOTE_SWEEP_INTERVAL_MS,
  schedule = setTimeout,
} = {}): () => void {
  let cursor: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
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
        try {
          await reconcileRemote(repo.id, repo.userId, { skipLocked: true });
        } catch (err) {
          logger.warn({ err, repositoryId: repo.id }, 'remote state reconciliation deferred');
        }
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
