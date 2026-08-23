import { and, eq, ne, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

/** Statuses whose worktree has been torn down, so the branch/directory is free again.
 *  `failed` is deliberately NOT here: a failed task keeps its worktree and branch on disk
 *  for recovery (its terminal tab stays usable, and a Retry lands back on that ref), so it
 *  still claims them. Same pair runtime-runner-reaper treats as "this task's resources are
 *  gone" — completion is 12-worktree-cleanup's job, cancel is removeTaskWorktree's. */
const RELEASED_STATUSES = ['completed', 'cancelled'] as const;

export interface WorktreeClaimant {
  id: string;
  title: string;
  status: string;
}

/** The other task, if any, that already claims `branchName` in this repository.
 *
 *  Two tasks must never share a branch: `worktreeDirName` maps a branch to exactly ONE
 *  directory under `.haive/worktrees/`, so the second task does not get its own tree — it
 *  adopts the first task's, silently, because 01-worktree-setup's `isRegistered` path logs
 *  "reusing existing worktree" and continues. Both `tasks.worktree_path` rows then point at
 *  one directory, and whichever task tears down first destroys the other's work.
 *
 *  Excludes the caller so a Retry / step reset of the SAME task re-enters its own worktree. */
export async function findBranchClaimant(
  db: Database,
  params: { repositoryId: string; branchName: string; taskId: string },
): Promise<WorktreeClaimant | null> {
  const row = await db.query.tasks.findFirst({
    where: and(
      eq(schema.tasks.repositoryId, params.repositoryId),
      eq(schema.tasks.worktreeBranch, params.branchName),
      ne(schema.tasks.id, params.taskId),
      notInArray(schema.tasks.status, [...RELEASED_STATUSES]),
    ),
    columns: { id: true, title: true, status: true },
  });
  return row ?? null;
}

/** The other task, if any, still pointing at `worktreePath`.
 *
 *  Guards the two destructive paths (cancel's removeTaskWorktree, step 12's cleanup) against
 *  deleting a directory a live task is working in. Only reachable for tasks that collided
 *  BEFORE findBranchClaimant existed — but those rows are on disk now, and the removal is
 *  not undoable. Path rather than branch, because the path is what gets rm'd. */
export async function findWorktreePathClaimant(
  db: Database,
  params: { worktreePath: string; taskId: string },
): Promise<WorktreeClaimant | null> {
  const row = await db.query.tasks.findFirst({
    where: and(
      eq(schema.tasks.worktreePath, params.worktreePath),
      ne(schema.tasks.id, params.taskId),
      notInArray(schema.tasks.status, [...RELEASED_STATUSES]),
    ),
    columns: { id: true, title: true, status: true },
  });
  return row ?? null;
}
