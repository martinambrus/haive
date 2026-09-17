import {
  chownNoFollow,
  ensureDirNoFollow,
  readdirNoFollow,
  removeNoFollow,
} from '@haive/shared/fs-safe';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import {
  TASK_SCRATCH_DIR,
  taskMayRunWithoutRepository,
  taskScratchSubpath,
  taskTypeAllowsNoRepository,
  taskWasCreatedRepoLess,
} from '@haive/shared';
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
  const dir = taskScratchPath(userId, taskId);
  // `<storage>/<userId>` is the anchor: it and its parents are the worker's, while everything below
  // is reachable from a sandbox. The owner passed here applies to what this call CREATES.
  const anchor = path.join(REPO_STORAGE_ROOT, userId);
  const rel = `${TASK_SCRATCH_DIR}/${taskId}`;
  const owner = { uid: SANDBOX_UID, gid: SANDBOX_GID };
  await ensureDirNoFollow(anchor, rel, { owner });
  try {
    // Separate from the create above, which only hands over directories it made: a scratch dir an
    // earlier run left root-owned still has to be repaired. A no-op when the owner already matches.
    await chownNoFollow(anchor, rel, owner);
  } catch (err) {
    // Best-effort, like `prepareAgentWritableDir`: on a host where chown is not permitted the
    // directory still exists and the agent still has a CWD to read from.
    log.warn({ err, taskId }, 'could not hand the scratch workspace to the sandbox user');
  }
  return dir;
}

/** Drop the workspace at task end. Best-effort: a leftover empty directory is untidy, never a
 *  reason to fail a teardown that is also releasing volumes and containers. */
export async function removeTaskScratchWorkspace(userId: string, taskId: string): Promise<void> {
  try {
    // The same split `ensureTaskScratchWorkspace` makes above: `<storage>/<userId>` is the
    // anchor, and the scratch dir below it is walked rather than trusted because everything
    // under a user dir is reachable from a sandbox. An already-absent dir answers `false`,
    // which needs no handling — that is what `force: true` bought before.
    await removeNoFollow(path.join(REPO_STORAGE_ROOT, userId), `${TASK_SCRATCH_DIR}/${taskId}`, {
      recursive: true,
    });
  } catch (err) {
    log.warn({ err, taskId }, 'could not remove the scratch workspace');
  }
}

/** Drop a repo-less task's workspace once nothing can still mount it.
 *
 *  Task completion deliberately does not wait for the best-effort step-summary invocation, so
 *  removing the directory at task end pulls it out from under a recap that is already starting
 *  — MEASURED, the recap was created 32 ms BEFORE completion and started 26 ms after it, and
 *  docker refused the mount with `cannot access path .../_scratch/<taskId>`. Unlike an auth
 *  volume, which docker itself refuses to remove while a container holds it, a directory is
 *  removed happily while mounted, so the deferral has to be explicit.
 *
 *  Both callers share this one rule: a pending summary means the LAST summary to finish does
 *  the removal (`cleanupAuthAfterTerminalSummary`), exactly as the auth volumes already work. */
export async function cleanupTaskScratchWorkspace(db: Database, taskId: string): Promise<boolean> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { userId: true, type: true, repositoryId: true, status: true },
  });
  // The TYPE-only check, deliberately, where the two mount resolvers use the stricter
  // `taskMayRunWithoutRepository`. Reaping is the one direction a deleted anchor must NOT make
  // stricter: a task that was handed a workspace before that rule existed still has a directory
  // on disk, and refusing to recognise it here would leak it for good. Creating one is the
  // decision worth guarding; removing one is not.
  if (!task || task.repositoryId || !taskTypeAllowsNoRepository(task.type)) return false;

  // Only a SETTLED, non-failed task gives up its workspace, and the check lives here so no
  // caller has to be ordered correctly. `markTaskCompleted` stamps `completed` and then runs
  // fallible bookkeeping; if one of those throws the task becomes `failed`, whose Editor and
  // Terminal are deliberately kept alive for recovery — so a reaper that fired on the earlier
  // status would have deleted the workspace those surfaces need. Guarding centrally also
  // retires the old `reason !== 'failed'` condition its callers each had to remember.
  if (task.status !== 'completed' && task.status !== 'cancelled') return false;

  // `endedAt IS NULL` alone is not "still running". A step retry supersedes the queued recap
  // WITHOUT ending it (`_step-reset.ts` sets `supersededAt` only, and its WHERE covers
  // `summaryForStepId`), and the job then returns at `handlers.ts`'s already-finalized guard
  // without stamping `endedAt` — so that row would read as pending forever and no later recap,
  // replacement included, could ever reap the workspace. The codebase's own definition of
  // finalized is `endedAt OR supersededAt` (`finalizedInvocationIds`, the per-task cap count).
  const pendingSummary = await db.query.cliInvocations.findFirst({
    where: and(
      eq(schema.cliInvocations.taskId, taskId),
      isNotNull(schema.cliInvocations.summaryForStepId),
      isNull(schema.cliInvocations.endedAt),
      isNull(schema.cliInvocations.supersededAt),
    ),
    columns: { id: true },
  });
  if (pendingSummary) return false;

  await removeTaskScratchWorkspace(task.userId, taskId);
  return true;
}

/** Task directory names are UUIDs. Anything else under `_scratch/` was not written by us, and a
 *  non-uuid handed to a uuid column throws rather than missing, so it is skipped and left alone. */
const TASK_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *  `cleanupTaskScratchWorkspace`, the same settled-and-no-pending-recap rule every other caller
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
    if (!userDir.isDirectory()) continue;
    const taskDirs = await readdirNoFollow(
      path.join(REPO_STORAGE_ROOT, userDir.name),
      TASK_SCRATCH_DIR,
    );
    if (taskDirs === null) continue; // this user has no scratch tree — the common case
    for (const taskDir of taskDirs) {
      if (!taskDir.isDirectory() || !TASK_DIR_NAME.test(taskDir.name)) continue;
      try {
        const task = await db.query.tasks.findFirst({
          where: eq(schema.tasks.id, taskDir.name),
          columns: { id: true },
        });
        if (!task) {
          await removeTaskScratchWorkspace(userDir.name, taskDir.name);
          removed += 1;
          continue;
        }
        if (await cleanupTaskScratchWorkspace(db, taskDir.name)) removed += 1;
      } catch (err) {
        // One unreadable task must not stop the sweep for the rest.
        log.warn({ err, taskId: taskDir.name }, 'scratch sweep skipped a workspace');
      }
    }
  }
  if (removed > 0) log.info({ removed }, 'swept scratch workspaces left by an interrupted reap');
}
