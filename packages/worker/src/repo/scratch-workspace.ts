import { chown, mkdir, readdir, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import { TASK_SCRATCH_DIR, taskScratchSubpath } from '@haive/shared';
import { SANDBOX_UID, SANDBOX_GID } from '../sandbox/sandbox-identity.js';

const log = logger.child({ module: 'scratch-workspace' });

/** Where repositories are stored, read the same way every other consumer reads it
 *  (`steps/workflow/01c-ddev-env.ts`, `_app-runtime.ts`). The scratch tree lives beside them
 *  so it rides the SAME named volume, which is what lets it be mounted into a sandbox with
 *  the existing subpath machinery instead of a second volume. */
const REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

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

/** Whether this task was CREATED without a repository, as opposed to having LOST one.
 *
 *  `taskTypeAllowsNoRepository` cannot answer that. It keys on the TYPE, and for `kb_author`
 *  the two meanings of a null `repository_id` wear the same type — so the allowlist alone
 *  re-admits exactly the torn state it was written to keep out. Deleting a repository sets the
 *  FK to NULL (`ON DELETE SET NULL`) and `cancelOpenTasksForRepo` skips terminal tasks, so a
 *  FAILED anchored task keeps its status and, on retry, reads as repo-less: it would be handed
 *  an empty workspace and told no repository was selected, and could then publish a DIFFERENT,
 *  generic article over the entry the author anchored on purpose.
 *
 *  An ABSENT record reads as ANCHORED, which is the opposite of the usual presence-bit default
 *  and is not a judgement call: `enrichSchema.repositoryId` was a REQUIRED uuid until this branch
 *  made it optional, so a `kb_author` task created before the record necessarily HAD a repository.
 *  Absent therefore means "anchored", never "unknown", and treating it as permissive would admit
 *  exactly the tasks the old schema proves were anchored. (`cli_choice_recorded`'s lenient default
 *  is the right shape only where the legacy state is genuinely ambiguous; here it is not.)
 *
 *  `backfillKbAuthorAnchors` stamps the record on the tasks that predate it, so the strict default
 *  applies only to a task no evidence could classify. */
export function taskWasCreatedRepoLess(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  if (!('anchorRepositoryId' in metadata)) return false;
  return (metadata as { anchorRepositoryId?: unknown }).anchorRepositoryId == null;
}

/** Whether THIS task may run without a repository: the type allows it AND it was not anchored to
 *  a repository that has since been deleted.
 *
 *  One rule, because the decision has THREE call sites and they are reached by different routes —
 *  `resolveTaskContext` when the task runs, and both mount resolvers, one of which the human
 *  Terminal calls directly without ever going through the task context. Splitting the two halves
 *  across those sites is how the deleted-anchor case came back after being closed in one of them.
 *
 *  `resolveTaskContext` deliberately does NOT use this: it distinguishes the two refusals in its
 *  error message, and "this type never runs repo-less" and "your anchor was deleted" are different
 *  things to tell someone. Here both mean the same thing — no scratch mount. */
export function taskMayRunWithoutRepository(task: { type: string; metadata: unknown }): boolean {
  return taskTypeAllowsNoRepository(task.type) && taskWasCreatedRepoLess(task.metadata);
}

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
  let userDirs: Dirent[];
  try {
    userDirs = await readdir(REPO_STORAGE_ROOT, { withFileTypes: true });
  } catch (err) {
    // No repo volume mounted (a worker that has never cloned anything) is not a fault.
    log.debug({ err }, 'scratch sweep found no repo storage root');
    return;
  }

  let removed = 0;
  for (const userDir of userDirs) {
    if (!userDir.isDirectory()) continue;
    const scratchRoot = path.join(REPO_STORAGE_ROOT, userDir.name, TASK_SCRATCH_DIR);
    let taskDirs: Dirent[];
    try {
      taskDirs = await readdir(scratchRoot, { withFileTypes: true });
    } catch {
      continue; // this user has no scratch tree — the common case
    }
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
