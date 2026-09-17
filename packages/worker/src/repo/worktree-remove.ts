import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { lstatNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { findWorktreePathClaimant } from './worktree-claims.js';
import { splitWorktreePath, WORKTREE_SUBDIR } from './worktree-paths.js';

const exec = promisify(execFile);

export interface WorktreeRemovalResult {
  removed: boolean;
  worktreePath: string | null;
  /** 'git' = removed via `git worktree remove` (also cleared the admin entry);
   *  'rmdir' = the parent .git was gone, so the directory was rm'd directly. */
  method: 'git' | 'rmdir' | null;
  error?: string;
}

export interface TaskWorktreeRemoval extends WorktreeRemovalResult {
  branch: string | null;
  /** True only when `git branch -d` succeeded — it refuses an unmerged branch, so a
   *  cancel that happened after a commit keeps the work recoverable. */
  branchDeleted: boolean;
}

/** Remove a workflow task's feature worktree at cancel time.
 *
 *  The deterministic workflow normally removes the worktree in 12-worktree-cleanup
 *  (the cleanup option the user ticks). A task cancelled BEFORE reaching that step
 *  leaks the worktree directory into the haive_repos volume — cleanupTaskContainers
 *  tears down the containers but never touched the worktree. This closes that gap
 *  for the cancel path only; completion is step 12's job and a `keep` choice there
 *  must be respected, so this is never called on a completed task.
 *
 *  Finds the worktree via the durable `tasks.worktree_path` / `worktree_branch`
 *  columns that 01-worktree-setup writes, falling back to that step's apply output
 *  for tasks predating those columns. It mirrors `git worktree remove --force`, then
 *  falls back to a plain recursive rm (plus a best-effort `git worktree prune`) when
 *  the parent repo's .git is gone — e.g. the repo was reset — which orphans the linked
 *  worktree so `git worktree remove` fails. Finally it safe-deletes the branch.
 *  No-op for in-place / no-git runs (nothing recorded a worktree). */
export async function removeTaskWorktree(
  db: Database,
  taskId: string,
): Promise<TaskWorktreeRemoval> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true, worktreePath: true, worktreeBranch: true },
  });

  // Prefer the durable task-row record. A Retry that cascades over 01-worktree-setup
  // nulls its step `output` while the worktree stays on disk, so reading the step
  // output alone made the reaper silently no-op and leak the worktree + branch.
  let worktreePath = task?.worktreePath ?? null;
  let branch = task?.worktreeBranch ?? null;

  // Fall back to the step output for tasks created before the columns existed.
  if (!worktreePath) {
    const rows = await db
      .select({ output: schema.taskSteps.output })
      .from(schema.taskSteps)
      .where(
        and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01-worktree-setup')),
      )
      .orderBy(desc(schema.taskSteps.round))
      .limit(1);
    const output = rows[0]?.output as {
      mode?: string;
      worktreePath?: string;
      branchName?: string;
    } | null;
    if (!output || output.mode !== 'worktree' || !output.worktreePath) {
      return {
        removed: false,
        worktreePath: null,
        method: null,
        branch: null,
        branchDeleted: false,
      };
    }
    worktreePath = output.worktreePath;
    branch = output.branchName ?? null;
  }

  // Another task may point at this exact directory: tasks that were handed the same
  // branch name before 01-worktree-setup guarded against it share ONE worktree, because
  // worktreeDirName maps a branch to exactly one path. Deleting it out from under a task
  // that is still live destroys its working tree mid-flight, and the delete is not
  // undoable — so leave it to whichever sharer releases last.
  const sharer = await findWorktreePathClaimant(db, { worktreePath, taskId });
  if (sharer) {
    logger.warn(
      { taskId, worktreePath, sharerTaskId: sharer.id, sharerStatus: sharer.status },
      'worktree is shared with another live task; left in place',
    );
    return { removed: false, worktreePath, method: null, branch, branchDeleted: false };
  }

  // The parent clone that owns the linked worktree (storage_path = repo root).
  const repo = task?.repositoryId
    ? await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, task.repositoryId),
        columns: { storagePath: true },
      })
    : null;
  const repoRoot = repo?.storagePath ?? null;
  const removal = await removeWorktreeDir(repoRoot, worktreePath);

  // Safe delete only: `-d` refuses a branch with unmerged commits, so a task
  // cancelled after 10-gate-3-commit keeps its work on the branch. Must follow the
  // worktree removal — git will not delete a branch that is still checked out.
  let branchDeleted = false;
  if (removal.removed && repoRoot && branch) {
    try {
      await exec('git', ['-C', repoRoot, 'branch', '-d', branch]);
      branchDeleted = true;
    } catch (err) {
      logger.info({ err, branch }, 'branch not deleted (unmerged or missing); left in place');
    }
  }
  return { ...removal, branch, branchDeleted };
}

/** The IO half of {@link removeTaskWorktree}, split out so the branching is unit-testable against a
 *  real temp repo without stubbing the db.
 *
 *  `git worktree remove --force` is deliberately no longer used: it is a root subprocess performing
 *  a path-based recursive delete inside a tree that sandboxed agents write, which is exactly the
 *  operation being retired here. The delete goes through the anchored walk instead, and
 *  `git worktree prune` clears the parent's `.git/worktrees` admin entry afterwards — the one thing
 *  `remove` did for us beyond deleting. `repairPermissions` replaces `forceRemoveDir`'s
 *  `chmod -R u+w` for read-only trees (Drupal ships `sites/default` at 0555). */
export async function removeWorktreeDir(
  repoRoot: string | null,
  worktreePath: string,
): Promise<WorktreeRemovalResult> {
  const split = splitWorktreePath(worktreePath);
  if (!split) {
    return {
      removed: false,
      worktreePath,
      method: null,
      error: `${worktreePath} does not name a worktree under ${WORKTREE_SUBDIR}/`,
    };
  }

  if (repoRoot) {
    // A CLI agent can repoint the gitfile at a container-side path, which leaves git unable to
    // resolve the worktree. Repair it — but only when it IS a regular file: cli-exec masks it
    // read-only while the terminal and IDE containers do not, so a link or a directory can sit
    // there, and `git worktree repair` would then act on whatever that names.
    const gitfile = await lstatNoFollow(split.anchor, `${split.rel}/.git`);
    if (gitfile?.kind === 'file') {
      await exec('git', ['-C', repoRoot, 'worktree', 'repair', worktreePath]).catch(
        () => undefined,
      );
    }
  }

  try {
    // The return value is deliberately ignored: absence is the desired END STATE, so a worktree that
    // was already gone is a success. Steps 12 and 13 both treat `removed: false` as loud failure.
    await removeNoFollow(split.anchor, split.rel, { recursive: true, repairPermissions: true });
    if (repoRoot) {
      await exec('git', ['-C', repoRoot, 'worktree', 'prune']).catch(() => undefined);
    }
    // Only ever 'rmdir' now; the 'git' variant stays in the type because step outputs written before
    // this change carry it and are replayed.
    return { removed: true, worktreePath, method: 'rmdir' };
  } catch (err) {
    return {
      removed: false,
      worktreePath,
      method: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
