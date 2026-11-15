import {
  chownNoFollow,
  ensureDirNoFollow,
  openDirNoFollow,
  readdirNoFollow,
  removeNoFollow,
} from '@haive/shared/fs-safe';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import {
  TASK_SCRATCH_DIR,
  taskMayRunWithoutRepository,
  taskScratchSubpath,
  taskTypeAllowsNoRepository,
  taskWasCreatedRepoLess,
} from '@haive/shared';
import { listCliSandboxesForTask } from '../sandbox/sandbox-kill.js';
import { SANDBOX_UID, SANDBOX_GID } from '../sandbox/sandbox-identity.js';

const log = logger.child({ module: 'scratch-workspace' });

/** Where repositories are stored, read the same way every other consumer reads it
 *  (`steps/workflow/01c-ddev-env.ts`, `_app-runtime.ts`). The scratch tree lives beside them
 *  so it rides the SAME named volume, which is what lets it be mounted into a sandbox with
 *  the existing subpath machinery instead of a second volume. */
const REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

// These three are PURE and now live in @haive/shared, because the api must apply the SAME rule
// and cannot import the worker. Re-exported so every importer here is unchanged.
export { taskMayRunWithoutRepository, taskTypeAllowsNoRepository, taskWasCreatedRepoLess };

// The path SHAPE lives in @haive/shared because the api roots the Editor at the same directory
// and cannot import the worker. Re-exported so existing importers here are unchanged.
export { taskScratchSubpath };

/** Absolute path as the WORKER sees it. */
export function taskScratchPath(userId: string, taskId: string): string {
  return path.join(REPO_STORAGE_ROOT, taskScratchSubpath(userId, taskId));
}

/** One worker per install: readers/materializers hold this section for their entire use,
 * not merely while resolving a path. Reaping and ensure use the same task key. An invocation
 * must be recorded before acquiring/mounting scratch, so its durable live row protects the
 * mount after this section ends. A snapshot reader without a run must retain the section. */
const scratchSections = new Map<string, Promise<void>>();
const TASK_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const userDirectoryName = (userId: string) =>
  userId !== '.' && userId !== '..' && /^[a-zA-Z0-9_-]+$/.test(userId);

export async function withTaskScratchWorkspace<T>(
  userId: string,
  taskId: string,
  use: () => Promise<T>,
): Promise<T> {
  if (!userDirectoryName(userId) || !TASK_DIR_NAME.test(taskId)) {
    throw new Error('Invalid scratch workspace owner or task id');
  }
  const key = taskId.toLowerCase();
  const prior = scratchSections.get(key);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  scratchSections.set(key, held);
  await prior;
  try {
    return await use();
  } finally {
    release();
    if (scratchSections.get(key) === held) scratchSections.delete(key);
  }
}

/** Create the workspace and hand it to the sandbox user.
 *
 *  A repo-less task still needs a working directory: the sandbox always runs with
 *  `-w /haive/workdir` whether or not anything is mounted there, and with no mount that path
 *  is the image's own `WORKDIR` — created root:root, while the CLI runs as uid 1000. Anything
 *  the CLI writes relative to its CWD then fails with EACCES. Mounting a real, owned directory
 *  is also what keeps `repoPath` a plain `string` everywhere: widening it to `string | null`
 *  would reach every step in the engine to fix one task type that has no repo.
 *
 *  Idempotent — `resolveTaskContext` runs on every advance, not once per task. */
export async function ensureTaskScratchWorkspace(userId: string, taskId: string): Promise<string> {
  return withTaskScratchWorkspace(userId, taskId, () => ensureScratchWorkspace(userId, taskId));
}

async function ensureScratchWorkspace(userId: string, taskId: string): Promise<string> {
  const dir = taskScratchPath(userId, taskId);
  // `<storage>/<userId>` is the anchor: it and its parents are the worker's, while everything below
  // is reachable from a sandbox.
  const rel = `${TASK_SCRATCH_DIR}/${taskId}`;
  const owner = { uid: SANDBOX_UID, gid: SANDBOX_GID };
  // A user whose first task has no repository has no directory here yet.
  await ensureDirNoFollow(REPO_STORAGE_ROOT, userId);
  const ownerDir = await openDirNoFollow(REPO_STORAGE_ROOT, userId);
  const anchor = `/proc/self/fd/${ownerDir.fd}`;
  try {
    // No owner on the create: fs-safe makes that chown strict, and handing the directory over is
    // best-effort, so a worker that may not chown still gets its workspace.
    await ensureDirNoFollow(anchor, rel);
    try {
      // Also repairs a scratch dir an earlier run left root-owned. A no-op when the owner already matches.
      await chownNoFollow(anchor, rel, owner);
    } catch (err) {
      // Best-effort, like `prepareAgentWritableDir`: on a host where chown is not permitted the
      // directory still exists and the agent still has a CWD to read from.
      log.warn({ err, taskId }, 'could not hand the scratch workspace to the sandbox user');
    }
    return dir;
  } finally {
    await ownerDir.close();
  }
}

/** Remove only the canonical task directory, with no path supplied by a repository or caller.
 * Best effort: boot retries an interrupted/failed reap. Called with the scratch section held. */
async function removeScratchWorkspace(userId: string, taskId: string): Promise<boolean> {
  try {
    // Hold the owner directory too: following a substituted anchor would bypass the
    // no-follow walk below it. The storage root is worker-owned; the user tree is not.
    const ownerDir = await openDirNoFollow(REPO_STORAGE_ROOT, userId);
    try {
      await removeNoFollow(`/proc/self/fd/${ownerDir.fd}`, `${TASK_SCRATCH_DIR}/${taskId}`, {
        recursive: true,
      });
    } finally {
      await ownerDir.close();
    }
    return true; // Already absent is also settled.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    log.warn({ err, taskId }, 'could not remove the scratch workspace');
    return false;
  }
}

/** Drop completed/cancelled scratch, repository-backed or repo-less, only once settled.
 * A queued run protects its mount as much as a started run. Superseded runs do not hold it,
 * but a sandbox they have not stopped yet still does: reuse cancellation's clean listing. */
export async function cleanupTaskScratchWorkspace(db: Database, taskId: string): Promise<boolean> {
  if (!TASK_DIR_NAME.test(taskId)) return false;
  const readTask = () =>
    db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: {
        userId: true,
        status: true,
        deadAt: true,
        pausedAt: true,
        orchestrationEpoch: true,
      },
    });
  const settled = (task: Awaited<ReturnType<typeof readTask>>) =>
    task && (task.status === 'completed' || task.status === 'cancelled') && !task.pausedAt;
  const task = await readTask();
  if (!settled(task) || !task || !userDirectoryName(task.userId)) return false;
  const epoch = task.orchestrationEpoch;
  return withTaskScratchWorkspace(task.userId, taskId, async () => {
    const pendingRun = () =>
      db.query.cliInvocations.findFirst({
        where: and(
          eq(schema.cliInvocations.taskId, taskId),
          isNull(schema.cliInvocations.endedAt),
          isNull(schema.cliInvocations.supersededAt),
        ),
        columns: { id: true },
      });
    if (await pendingRun()) return false;
    if ((await listCliSandboxesForTask(taskId))?.length !== 0) return false;
    // The probe and the section wait yield to Retry/continuation. Admission is decided
    // again here, with the section held through removal so ensure cannot recreate beneath it.
    if (await pendingRun()) return false;
    const latest = await readTask();
    if (
      !settled(latest) ||
      !latest ||
      latest.userId !== task.userId ||
      latest.orchestrationEpoch !== epoch
    )
      return false;
    return removeScratchWorkspace(task.userId, taskId);
  });
}

/** Reap the workspaces the happy path could not.
 *
 *  `markTaskCompleted` stamps the status first and reaps LAST — deliberately, so nothing after
 *  the reap can turn `completed` back into `failed` — which leaves a window where a worker that
 *  exits in between abandons `_scratch/<taskId>` for good. Redelivery cannot recover it: a
 *  `completed` task is never advanced again, by `handleAdvanceStep`'s own guard. One directory
 *  per crash, accumulating, with nothing else in the tree looking at them.
 *
 *  CONVERGENT, not destructive, and the distinction is the guard rather than the `rm`: every
 *  directory removed here is one the normal path had already decided to remove. A task that is
 *  still live keeps its workspace, because this pass does not re-decide that — it defers to
 *  `cleanupTaskScratchWorkspace`, the same settled-and-no-live-invocation rule every other caller
 *  gets. A directory whose task ROW is gone is the one case that function cannot reap, since it
 *  keys on a task it can no longer read, so it is handled here instead.
 *
 *  Runs at boot, before any queue starts, so nothing it examines can be mid-flight. */
export async function sweepOrphanScratchWorkspaces(db: Database): Promise<void> {
  // `rel: ''` addresses the anchor itself, which is the one directory here that IS trusted: the
  // storage root and its parents are the worker's, and only what sits below a `<userId>` dir is
  // reachable from a sandbox. Lenient, so null covers an unmounted volume as the `catch` did.
  const userDirs: Dirent[] | null = await readdirNoFollow(REPO_STORAGE_ROOT, '');
  if (userDirs === null) {
    // No repo volume mounted (a worker that has never cloned anything) is not a fault.
    log.debug('scratch sweep found no repo storage root');
    return;
  }

  let removed = 0;
  for (const userDir of userDirs) {
    if (!userDir.isDirectory() || !userDirectoryName(userDir.name)) continue;
    const taskDirs = await readdirNoFollow(
      REPO_STORAGE_ROOT,
      `${userDir.name}/${TASK_SCRATCH_DIR}`,
    );
    if (taskDirs === null) continue; // this user has no scratch tree — the common case
    for (const taskDir of taskDirs) {
      if (!taskDir.isDirectory() || !TASK_DIR_NAME.test(taskDir.name)) continue;
      try {
        const task = await db.query.tasks.findFirst({
          where: eq(schema.tasks.id, taskDir.name),
          columns: { userId: true },
        });
        if (!task) {
          // Separate boot-only scope: no row can supply an owner. Recheck absence under
          // the same fence, and remove exactly the enumerated user's no-follow directory.
          const reaped = await withTaskScratchWorkspace(userDir.name, taskDir.name, async () => {
            if ((await listCliSandboxesForTask(taskDir.name))?.length !== 0) return false;
            const appeared = await db.query.tasks.findFirst({
              where: eq(schema.tasks.id, taskDir.name),
              columns: { id: true },
            });
            if (appeared) return false;
            return removeScratchWorkspace(userDir.name, taskDir.name);
          });
          if (reaped) removed += 1;
          continue;
        }
        if (task.userId !== userDir.name) continue;
        if (await cleanupTaskScratchWorkspace(db, taskDir.name)) removed += 1;
      } catch (err) {
        // One unreadable task must not stop the sweep for the rest.
        log.warn({ err, taskId: taskDir.name }, 'scratch sweep skipped a workspace');
      }
    }
  }
  if (removed > 0) log.info({ removed }, 'swept scratch workspaces left by an interrupted reap');
}
