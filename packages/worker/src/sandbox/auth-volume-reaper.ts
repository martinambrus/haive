import { spawn } from 'node:child_process';
import { notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  cliAuthIdSlug,
  cliAuthTaskVolumePrefix,
  cliAuthVolumeOwner,
  cliAuthVolumePrefix,
  logger,
} from '@haive/shared';
import { defaultDockerRunner } from './docker-runner.js';

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
  listAuthVolumes: () => Promise<string[]>;
  /** Every container mounting the volume, running or not: only called once its owner row is gone. */
  removeContainersUsingVolume?: (name: string) => Promise<void>;
  removeStoppedContainersUsingVolume?: (name: string) => Promise<void>;
  removeVolume: (name: string) => Promise<void>;
}

function runDocker(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('docker', args);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('close', () => resolve(stdout));
    child.on('error', () => resolve(stdout));
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve(stdout);
    }, timeoutMs);
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
  async removeStoppedContainersUsingVolume(name) {
    const result = await defaultDockerRunner.removeStoppedContainersUsingVolume?.(name);
    if (result && !result.ok) {
      throw new Error(result.stderr || `failed to remove stopped containers using ${name}`);
    }
  },
};

/** Names of every per-task CLI auth volume currently on the host.
 *
 *  Exported for the credential refresher, which must not rotate a user-volume credential
 *  while any task still holds a COPY of it: both sides would refresh off the same
 *  single-use refresh token and whichever lost the race would be signed out mid-run. */
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
  const live: LiveAuthOwners = {
    tasks: slugs(
      await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(notInArray(schema.tasks.status, [...TERMINAL_STATUSES])),
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
  for (const name of orphans) {
    try {
      // A task copy spares a running container, which may be a recap of that task still starting.
      // A provider's or user's has no owner left to serve, so a login session still holding it goes.
      if (cliAuthVolumeOwner(name)?.kind === 'task') {
        await deps.removeStoppedContainersUsingVolume?.(name);
      } else {
        await deps.removeContainersUsingVolume?.(name);
      }
      await deps.removeVolume(name);
      removed += 1;
    } catch (err) {
      log.warn({ err, volume: name }, 'orphaned auth volume cleanup failed');
    }
  }
  return removed;
}
