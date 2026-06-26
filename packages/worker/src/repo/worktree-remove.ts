import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';

const exec = promisify(execFile);

export interface WorktreeRemovalResult {
  removed: boolean;
  worktreePath: string | null;
  /** 'git' = removed via `git worktree remove` (also cleared the admin entry);
   *  'rmdir' = the parent .git was gone, so the directory was rm'd directly. */
  method: 'git' | 'rmdir' | null;
  error?: string;
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
 *  Reads the 01-worktree-setup apply output to find the worktree path + mode, then
 *  mirrors `git worktree remove --force`. Falls back to a plain recursive rm (plus a
 *  best-effort `git worktree prune`) when the parent repo's .git is gone — e.g. the
 *  repo was reset — which orphans the linked worktree so `git worktree remove` fails.
 *  No-op for in-place / no-git runs (output.mode !== 'worktree'). */
export async function removeTaskWorktree(
  db: Database,
  taskId: string,
): Promise<WorktreeRemovalResult> {
  // 01-worktree-setup's apply output (latest round) records the worktree path/mode.
  const rows = await db
    .select({ output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .where(
      and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01-worktree-setup')),
    )
    .orderBy(desc(schema.taskSteps.round))
    .limit(1);
  const output = rows[0]?.output as { mode?: string; worktreePath?: string } | null;
  if (!output || output.mode !== 'worktree' || !output.worktreePath) {
    return { removed: false, worktreePath: null, method: null };
  }
  const worktreePath = output.worktreePath;

  // The parent clone that owns the linked worktree (storage_path = repo root).
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  const repo = task?.repositoryId
    ? await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, task.repositoryId),
        columns: { storagePath: true },
      })
    : null;
  return removeWorktreeDir(repo?.storagePath ?? null, worktreePath);
}

/** The IO half of {@link removeTaskWorktree}, split out so the git-vs-rmdir
 *  branching is unit-testable against a real temp repo without stubbing the db.
 *  Prefers `git worktree remove --force` (clears the parent's .git/worktrees admin
 *  entry too); falls back to a plain recursive rm + best-effort prune when there is
 *  no reachable parent .git (repoRoot null, or the parent repo was reset). */
export async function removeWorktreeDir(
  repoRoot: string | null,
  worktreePath: string,
): Promise<WorktreeRemovalResult> {
  if (repoRoot) {
    try {
      await exec('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath]);
      return { removed: true, worktreePath, method: 'git' };
    } catch (err) {
      logger.warn({ err, worktreePath }, 'git worktree remove failed; falling back to rm');
    }
  }

  try {
    await rm(worktreePath, { recursive: true, force: true });
    if (repoRoot) {
      await exec('git', ['-C', repoRoot, 'worktree', 'prune']).catch(() => undefined);
    }
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
