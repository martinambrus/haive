import { chown, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import { SANDBOX_UID, SANDBOX_GID } from '../sandbox/sandbox-identity.js';

const log = logger.child({ module: 'scratch-workspace' });

/** Where repositories are stored, read the same way every other consumer reads it
 *  (`steps/workflow/01c-ddev-env.ts`, `_app-runtime.ts`). The scratch tree lives beside them
 *  so it rides the SAME named volume, which is what lets it be mounted into a sandbox with
 *  the existing subpath machinery instead of a second volume. */
const REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

/** Directory name for scratch workspaces, under the user's own repo directory. Cannot collide
 *  with a sibling: every other entry there is a repository UUID. */
const SCRATCH_DIR = '_scratch';

/** Task types that may run with no repository.
 *
 *  An allowlist and not a blanket "null is fine", because a null `repositoryId` has TWO
 *  meanings: a task deliberately created without one, and a task whose repository was deleted
 *  out from under it (`tasks.repository_id` is `ON DELETE SET NULL`). The second is a torn
 *  state and should still fail loudly — a workflow run whose repo vanished cannot do anything
 *  useful, and silently handing it an empty directory would turn that into a confusing agent
 *  failure several minutes later. */
const REPO_OPTIONAL_TASK_TYPES: ReadonlySet<string> = new Set(['kb_author']);

export function taskTypeAllowsNoRepository(type: string): boolean {
  return REPO_OPTIONAL_TASK_TYPES.has(type);
}

/** Volume-relative path of a task's scratch workspace — the shape `resolveInvocationRepoMount`
 *  already uses for a repository (`<userId>/<repositoryId>`). */
export function taskScratchSubpath(userId: string, taskId: string): string {
  return `${userId}/${SCRATCH_DIR}/${taskId}`;
}

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
  await mkdir(dir, { recursive: true });
  try {
    await chown(dir, SANDBOX_UID, SANDBOX_GID);
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
    await rm(taskScratchPath(userId, taskId), { recursive: true, force: true });
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
export async function cleanupTaskScratchWorkspace(db: Database, taskId: string): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { userId: true, type: true, repositoryId: true, status: true },
  });
  if (!task || task.repositoryId || !taskTypeAllowsNoRepository(task.type)) return;

  // Only a SETTLED, non-failed task gives up its workspace, and the check lives here so no
  // caller has to be ordered correctly. `markTaskCompleted` stamps `completed` and then runs
  // fallible bookkeeping; if one of those throws the task becomes `failed`, whose Editor and
  // Terminal are deliberately kept alive for recovery — so a reaper that fired on the earlier
  // status would have deleted the workspace those surfaces need. Guarding centrally also
  // retires the old `reason !== 'failed'` condition its callers each had to remember.
  if (task.status !== 'completed' && task.status !== 'cancelled') return;

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
  if (pendingSummary) return;

  await removeTaskScratchWorkspace(task.userId, taskId);
}
