import { basename, join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { decideTaskWorktree, type TaskWorktreeDecision } from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { WORKTREE_SUBDIR, worktreeDirName } from './worktree-paths.js';

export class WorktreeRemovedError extends Error {
  constructor(readonly branch: string) {
    super(
      `The worktree for branch "${branch}" was removed, so this task has no workspace to open.`,
    );
    this.name = 'WorktreeRemovedError';
  }
}

export class WorktreeNotDirectoryError extends Error {
  constructor(readonly branch: string) {
    super(`The worktree path for branch "${branch}" is not a directory, so it cannot be opened.`);
    this.name = 'WorktreeNotDirectoryError';
  }
}

export interface TaskWorktreePointer {
  taskId: string;
  columnBranch: string | null | undefined;
  columnPath: string | null | undefined;
}

/** The pure decision, fed with 01's LATEST round. No directory check. */
export async function loadTaskWorktreeDecision(
  db: Database,
  pointer: TaskWorktreePointer,
): Promise<TaskWorktreeDecision> {
  const latest = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, pointer.taskId),
      eq(schema.taskSteps.stepId, '01-worktree-setup'),
    ),
    orderBy: [desc(schema.taskSteps.round)],
    columns: { status: true, output: true },
  });
  return decideTaskWorktree({
    columnBranch: pointer.columnBranch,
    columnPath: pointer.columnPath,
    latestStatus: latest?.status,
    output: latest?.output,
  });
}

/** The worker path of a repository's root: where 01-worktree-setup puts its worktrees. Null when
 *  the row is gone or names no path. */
export async function loadRepositoryRoot(
  db: Database,
  repositoryId: string,
): Promise<string | null> {
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { storagePath: true, localPath: true },
  });
  return repo?.storagePath ?? repo?.localPath ?? null;
}

/** The worktree a task works in NOW: `root`, or a worktree whose directory is still on disk.
 *  A recorded worktree that is gone throws rather than answering the repository root, which
 *  would put a read-write agent on the main checkout. `repoRoot` is the worker path of the
 *  repository root, the only anchor the existence walk may follow; null skips the walk. */
export async function resolveTaskWorktree(
  db: Database,
  pointer: TaskWorktreePointer,
  repoRoot: string | null,
): Promise<{ kind: 'root' } | { kind: 'worktree'; branch: string }> {
  const decision = await loadTaskWorktreeDecision(db, pointer);
  if (decision.kind === 'root') return decision;
  const branch = decision.branch ?? basename(decision.path ?? '');
  if (repoRoot === null) return { kind: 'worktree', branch };
  const entry = await lstatNoFollow(repoRoot, `${WORKTREE_SUBDIR}/${worktreeDirName(branch)}`);
  if (entry === null) throw new WorktreeRemovedError(branch);
  if (entry.kind !== 'directory') throw new WorktreeNotDirectoryError(branch);
  return { kind: 'worktree', branch };
}

/** The decided worktree's absolute worker path, or null for the repository root. */
export function decidedWorktreePath(
  decision: TaskWorktreeDecision,
  repoRoot: string,
): string | null {
  if (decision.kind === 'root') return null;
  return decision.path ?? join(repoRoot, WORKTREE_SUBDIR, worktreeDirName(decision.branch ?? ''));
}
