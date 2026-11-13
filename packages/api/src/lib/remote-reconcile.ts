import { and, asc, eq, gt } from 'drizzle-orm';
import { schema } from '@haive/database';
import { linkRepoRemoteRequestSchema, logger } from '@haive/shared';
import {
  ensureDirNoFollow,
  errno,
  lstatNoFollow,
  removeFileIfNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { redactEditableGitUrl } from '@haive/shared/schemas';
import { getDb, withFreshDatabase } from '../db.js';
import { HttpError } from '../context.js';
import { boundedLockWait } from './repository-busy.js';
import { gitFailureText, relinkGit, verifyRelinkCheckout } from './relink-git.js';

// Only an attempted relink makes Git's origin database-managed. Folder imports may
// legitimately have an origin and no remote_url, so never sweep those indiscriminately.
export const REMOTE_PENDING_PATH = '.haive/remote-relink-pending';
export const REMOTE_SWEEP_BATCH = 25;
export const REMOTE_SWEEP_INTERVAL_MS = 30_000;

export async function markRemotePending(root: string): Promise<void> {
  const owner = await lstatNoFollow(root, '.', { strict: true });
  if (!owner) throw new Error('Repository root is unavailable');
  await ensureDirNoFollow(root, '.haive', { owner: owner.stats });
  await writeFileNoFollow(root, REMOTE_PENDING_PATH, 'pending\n', {
    durable: true,
    fileMode: 0o600,
  });
}

export async function clearRemotePending(root: string): Promise<void> {
  const outcome = await removeFileIfNoFollow(
    root,
    REMOTE_PENDING_PATH,
    (data) => data.toString() === 'pending\n',
    { maxBytes: 32 },
  );
  if (outcome === 'kept') throw new Error('Remote reconciliation intent changed');
}

async function hasRemotePending(root: string): Promise<boolean> {
  try {
    const entry = await lstatNoFollow(root, REMOTE_PENDING_PATH, { strict: true });
    if (!entry) return false;
    if (entry.kind !== 'file') throw new Error('Remote reconciliation intent is not a file');
    return true;
  } catch (err) {
    if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR') return false;
    throw err;
  }
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

/** A fresh locked read is the authority, never the route's pre-transaction snapshot. */
export async function reconcileRemote(id: string, userId: string, force = false): Promise<void> {
  await withFreshDatabase(async (db) => {
    await db.transaction(async (tx) => {
      const [repo] = await boundedLockWait(tx, () =>
        tx
          .select()
          .from(schema.repositories)
          .where(and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)))
          .for('no key update'),
      );
      if (!repo) return; // A delete won the lock; do not touch its former checkout.
      const root = repo.storagePath ?? repo.localPath;
      if (!root) throw new Error('Repository has no path for remote reconciliation');
      if (!force && !(await hasRemotePending(root))) return;
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
      await clearRemotePending(root);
      logger.info({ repositoryId: id }, 'reconciled repository remote to the database');
    });
  });
}

type RemoteRepo = {
  id: string;
  userId: string;
  storagePath: string | null;
  localPath: string | null;
};
export async function reconcileRemoteOnRead(repo: RemoteRepo): Promise<void> {
  const root = repo.storagePath ?? repo.localPath;
  if (!root) return;
  try {
    if (await hasRemotePending(root)) await reconcileRemote(repo.id, repo.userId);
  } catch (err) {
    logger.warn({ err, repositoryId: repo.id }, 'remote state reconciliation deferred');
    throw new HttpError(503, 'Repository remote state is being reconciled; try again');
  }
}

/** One bounded page per tick, rotating through IDs. No request-pool connection spans Git. */
export function startRemoteReconcileSweep({
  batchSize = REMOTE_SWEEP_BATCH,
  intervalMs = REMOTE_SWEEP_INTERVAL_MS,
} = {}): () => void {
  let cursor: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    try {
      const repos = await getDb().query.repositories.findMany({
        where: cursor ? gt(schema.repositories.id, cursor) : undefined,
        orderBy: [asc(schema.repositories.id)],
        limit: batchSize,
        columns: { id: true, userId: true, storagePath: true, localPath: true },
      });
      cursor = repos.length === batchSize ? repos.at(-1)!.id : undefined;
      for (const repo of repos) {
        if (stopped) break;
        try {
          await reconcileRemoteOnRead(repo);
        } catch {
          /* Logged by the per-repository owner; retry on the next rotation. */
        }
      }
    } catch (err) {
      logger.warn({ err }, 'remote reconciliation sweep deferred');
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          void tick();
        }, intervalMs);
        timer.unref();
      }
    }
  };
  timer = setTimeout(() => {
    void tick();
  }, 0);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
