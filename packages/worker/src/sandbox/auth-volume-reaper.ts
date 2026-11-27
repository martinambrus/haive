import { spawn } from 'node:child_process';
import { schema, type Database } from '@haive/database';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  cliAuthIdSlug,
  cliAuthTaskVolumePrefix,
  cliAuthVolumeOwner,
  cliAuthVolumePrefix,
  logger,
  setTaskSettlementTimeout,
  taskWriteTarget,
  withTaskSettlementTransaction,
} from '@haive/shared';
import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';
import {
  clearTaskAuthPreparationState,
  syncRefreshedAuthToUserVolumes,
} from './task-auth-volume.js';

const log = logger.child({ module: 'auth-volume-reaper' });

/** Substrings the docker `name=` filters narrow on; the name is re-checked exactly after, since
 *  docker name filters are substring, not prefix. */
const AUTH_VOL_FILTER = cliAuthVolumePrefix();
const TASK_VOL_FILTER = cliAuthTaskVolumePrefix();
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/** Slugs of the owners whose auth volumes are still wanted. */
export interface LiveAuthOwners {
  tasks: Set<string>;
  providers: Set<string>;
  users: Set<string>;
}

/** Pure core: from all volume names, pick the CLI auth volumes nothing needs any more: a task's copy
 *  whose task is not live, and an isolated provider's or a user's whose row is gone. Exported for
 *  testing. */
export function selectOrphanAuthVolumes(names: string[], live: LiveAuthOwners): string[] {
  return names.filter((name) => {
    const owner = cliAuthVolumeOwner(name);
    if (!owner) return false;
    const liveSlugs =
      owner.kind === 'task' ? live.tasks : owner.kind === 'provider' ? live.providers : live.users;
    return !liveSlugs.has(owner.slug);
  });
}

export interface AuthVolumeReaperDeps {
  runner?: DockerRunner;
  listAuthVolumes: () => Promise<string[]>;
  /** Every container mounting the volume, running or not: only called once its owner row is gone. */
  removeContainersUsingVolume?: (name: string) => Promise<void>;
  removeStoppedContainersUsingVolume?: (name: string, signal?: AbortSignal) => Promise<void>;
  removeVolume: (name: string) => Promise<void>;
}

function runDocker(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('docker', args);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(stdout);
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

async function listVolumes(filter: string): Promise<string[]> {
  const out = await runDocker(['volume', 'ls', '-q', '--filter', `name=${filter}`], 10_000);
  return out.split(/\s+/).filter((s) => s.length > 0);
}

const defaultDeps: AuthVolumeReaperDeps = {
  listAuthVolumes: () => listVolumes(AUTH_VOL_FILTER),
  async removeContainersUsingVolume(name) {
    const out = await runDocker(['ps', '-aq', '--filter', `volume=${name}`], 15_000);
    const ids = out.split(/\s+/).filter((id) => id.length > 0);
    if (ids.length > 0) await runDocker(['rm', '-f', ...ids], 30_000);
  },
  async removeVolume(name) {
    const result = await defaultDockerRunner.volumeRemove(name);
    if (!result.ok) throw new Error(result.stderr || `failed to remove volume ${name}`);
  },
  async removeStoppedContainersUsingVolume(name, signal) {
    const result = await defaultDockerRunner.removeStoppedContainersUsingVolume?.(name, signal);
    if (result && !result.ok) {
      throw new Error(result.stderr || `failed to remove stopped containers using ${name}`);
    }
  },
};

/** Names of every per-task CLI auth volume currently on the host.
 *
 *  Exported for the credential refresher, which must not rotate a user-volume credential
 *  while live work holds a COPY of it. This listing also includes terminal recovery
 *  copies: callers must check task/invocation activity and the source label before
 *  treating a copy as a refresh hold. */
export async function listTaskAuthVolumes(): Promise<string[]> {
  return listVolumes(TASK_VOL_FILTER);
}

/**
 * Reap CLI auth volumes nothing needs any more, on worker boot. A per-task copy is normally removed
 * by cleanupTaskContainers at task end, but a worker killed mid-teardown (tsx watch restart, SIGKILL,
 * OOM) leaks it, and a later teardown can't recover another task's volumes; one whose task is still
 * live is kept, since a running task may be mid-use. An isolated provider's volumes and a user's
 * (subscription or API key) outlive the row they belong to, keeping its CLI credentials on the host,
 * so they go once that row is gone. Best-effort + idempotent.
 */
export async function reapOrphanedAuthVolumes(
  db: Database,
  deps: AuthVolumeReaperDeps = defaultDeps,
): Promise<number> {
  const names = await deps.listAuthVolumes();
  if (names.length === 0) return 0;

  const slugs = (rows: { id: string }[]) => new Set(rows.map((r) => cliAuthIdSlug(r.id)));
  // Keep the full id for ledger-based sync-back. A volume's truncated slug alone cannot
  // identify the provider row (in particular an isolated provider's user volume).
  const tasks = await db
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks);
  const tasksBySlug = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const slug = cliAuthIdSlug(task.id);
    tasksBySlug.set(slug, [...(tasksBySlug.get(slug) ?? []), task]);
  }
  const live: LiveAuthOwners = {
    tasks: slugs(
      tasks.filter((task) => !TERMINAL_STATUSES.some((status) => task.status === status)),
    ),
    providers: slugs(await db.select({ id: schema.cliProviders.id }).from(schema.cliProviders)),
    users: slugs(await db.select({ id: schema.users.id }).from(schema.users)),
  };

  const orphans = selectOrphanAuthVolumes(names, live);
  if (orphans.length === 0) return 0;

  log.warn(
    { orphans: orphans.length, total: names.length },
    'reaping CLI auth volumes whose task, provider or user is gone',
  );
  let removed = 0;
  const handledTasks = new Set<string>();
  const remove = async (name: string, signal?: AbortSignal) => {
    try {
      signal?.throwIfAborted();
      // A running task container may still be finishing a recap. Never force it off.
      if (cliAuthVolumeOwner(name)?.kind === 'task') {
        await deps.removeStoppedContainersUsingVolume?.(name, signal);
      } else {
        await deps.removeContainersUsingVolume?.(name);
      }
      signal?.throwIfAborted();
      await deps.removeVolume(name);
      removed += 1;
    } catch (err) {
      log.warn({ err, volume: name }, 'orphaned auth volume cleanup failed');
    }
  };
  for (const name of orphans) {
    try {
      const owner = cliAuthVolumeOwner(name);
      const matches = owner?.kind === 'task' ? tasksBySlug.get(owner.slug) : undefined;
      if (matches?.length) {
        // Slug collisions are ambiguous; never sync or destroy either task's credential.
        if (matches.length !== 1) continue;
        const taskId = matches[0]!.id;
        if (handledTasks.has(taskId)) continue;
        handledTasks.add(taskId);
        const task = await db.query.tasks.findFirst({
          where: taskWriteTarget(taskId, { settled: true }),
          columns: { id: true },
        });
        if (!task) continue;
        const hasLiveInvocation = async (database: Pick<Database, 'query'>) =>
          Boolean(
            await database.query.cliInvocations.findFirst({
              where: and(
                eq(schema.cliInvocations.taskId, taskId),
                isNotNull(schema.cliInvocations.startedAt),
                isNull(schema.cliInvocations.endedAt),
                isNull(schema.cliInvocations.supersededAt),
              ),
              columns: { id: true },
            }),
          );
        // As in harvest: the CLI rewrites its credential in place. A terminal task
        // can still have a recap or redelivered invocation; leave its copies alone.
        if (await hasLiveInvocation(db)) continue;
        // As in terminal-summary cleanup: auth lock waits must stay OUTSIDE task-row
        // locks. A lookup failure retains the task copies for the next boot.
        const sync = await syncRefreshedAuthToUserVolumes(
          db,
          taskId,
          deps.runner ?? defaultDockerRunner,
          0,
          false,
        );
        if (sync?.retainTaskCopy) {
          log.info(
            { taskId, reason: 'sync_retry_required' },
            'keeping task auth copies for a later reap',
          );
          continue;
        }
        const volumes = orphans.filter((volume) => {
          const candidate = cliAuthVolumeOwner(volume);
          return candidate?.kind === 'task' && candidate.slug === owner!.slug;
        });
        await withTaskSettlementTransaction(db, async (tx, signal) => {
          await setTaskSettlementTimeout(tx);
          const [settled] = await tx
            .select({ id: schema.tasks.id })
            .from(schema.tasks)
            .where(taskWriteTarget(taskId, { settled: true }))
            .for('no key update');
          if (!settled) return;
          if (await hasLiveInvocation(tx)) return;
          signal.throwIfAborted();
          clearTaskAuthPreparationState(taskId);
          for (const volume of volumes) {
            signal.throwIfAborted();
            await remove(volume, signal);
          }
        });
      } else {
        // No task/provider/user row remains to sync or lock, as on the original path.
        await remove(name);
      }
    } catch (err) {
      log.warn({ err, volume: name }, 'orphaned auth volume cleanup failed');
    }
  }
  return removed;
}
