import { spawn } from 'node:child_process';
import { notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { isCliAuthTaskVolume, logger } from '@haive/shared';

const log = logger.child({ module: 'auth-volume-reaper' });

/** Substring the docker `name=` filter narrows on; `isCliAuthTaskVolume` then
 *  re-checks the exact prefix (docker name filters are substring, not prefix). */
const TASK_VOL_FILTER = 'haive_cli_auth_task_';
const TASK_VOL_PREFIX = 'haive_cli_auth_task_';
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/** The task-id slug a per-task auth volume embeds: first 12 hex of the task uuid
 *  with dashes stripped (see cliAuthTaskVolumeName). */
function taskSlugOf(volumeName: string): string {
  return volumeName.slice(TASK_VOL_PREFIX.length).split('_')[0] ?? '';
}

/** Pure core: from all volume names, pick the per-task auth volumes whose task is
 *  not live. Filters to `isCliAuthTaskVolume` first, so per-user and per-provider
 *  auth volumes (no `_task_` segment) are never selected. Exported for testing. */
export function selectOrphanTaskAuthVolumes(names: string[], liveSlugs: Set<string>): string[] {
  return names.filter((name) => {
    if (!isCliAuthTaskVolume(name)) return false;
    const slug = taskSlugOf(name);
    return slug.length > 0 && !liveSlugs.has(slug);
  });
}

export interface AuthVolumeReaperDeps {
  listTaskAuthVolumes: () => Promise<string[]>;
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

const defaultDeps: AuthVolumeReaperDeps = {
  async listTaskAuthVolumes() {
    const out = await runDocker(
      ['volume', 'ls', '-q', '--filter', `name=${TASK_VOL_FILTER}`],
      10_000,
    );
    return out.split(/\s+/).filter((s) => s.length > 0);
  },
  async removeVolume(name) {
    await runDocker(['volume', 'rm', '-f', name], 15_000);
  },
};

/**
 * Reap per-task CLI auth volumes whose task has ended (terminal) or no longer
 * exists. These are normally removed by cleanupTaskContainers at task end, but a
 * worker killed mid-teardown (tsx watch restart, SIGKILL, OOM) leaks them — a
 * later teardown can't recover another task's volumes, so this runs on worker
 * boot as the backstop. Keeps volumes for any still-live task (a running task may
 * be mid-use) and never touches per-user or per-provider auth volumes (no
 * `_task_` segment → `isCliAuthTaskVolume` is false). Best-effort + idempotent.
 */
export async function reapOrphanedTaskAuthVolumes(
  db: Database,
  deps: AuthVolumeReaperDeps = defaultDeps,
): Promise<number> {
  const names = await deps.listTaskAuthVolumes();
  if (names.length === 0) return 0;

  // A per-task auth volume is an orphan unless its task is still live. Collect the
  // slugs of non-terminal tasks; everything else is reapable.
  const liveTasks = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(notInArray(schema.tasks.status, [...TERMINAL_STATUSES]));
  const liveSlugs = new Set(liveTasks.map((t) => t.id.replace(/-/g, '').slice(0, 12)));

  const orphans = selectOrphanTaskAuthVolumes(names, liveSlugs);
  if (orphans.length === 0) return 0;

  log.warn(
    { orphans: orphans.length, total: names.length, live: liveSlugs.size },
    'reaping orphaned per-task auth volumes left by an interrupted teardown',
  );
  for (const name of orphans) {
    await deps.removeVolume(name);
  }
  return orphans.length;
}
