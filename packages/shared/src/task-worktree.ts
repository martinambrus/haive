/** Where 01-worktree-setup puts a task's feature worktree, relative to the repo root.
 *  Already git-excluded via .git/info/exclude. */
export const WORKTREE_SUBDIR = '.haive/worktrees';

/** The worktree DIRECTORY name for a branch. A namespaced branch (`feature/x`)
 *  flattens its slashes so the on-disk layout stays one level under the subdir; the
 *  branch ref keeps its slash. */
export function worktreeDirName(branch: string): string {
  return branch.replace(/\//g, '-');
}

export interface TaskWorktreeInput {
  columnBranch: string | null | undefined;
  columnPath: string | null | undefined;
  /** Status of the LATEST round of 01-worktree-setup; null when it has no row. */
  latestStatus: string | null | undefined;
  /** Output of that same row. */
  output: unknown;
}

export type TaskWorktreeDecision =
  { kind: 'root' } | { kind: 'worktree'; branch: string | null; path: string | null };

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Where a task works NOW. `tasks.worktree_branch` / `worktree_path` are audit history and outlive
 *  a Skip of 01-worktree-setup, so the latest round's status is consulted first. The columns win;
 *  01's output answers only for a task written before the columns existed. */
export function decideTaskWorktree(input: TaskWorktreeInput): TaskWorktreeDecision {
  if (input.latestStatus === 'skipped') return { kind: 'root' };
  const out = (input.output ?? {}) as { branchName?: unknown; worktreePath?: unknown };
  const columnBranch = nonEmpty(input.columnBranch);
  const columnPath = nonEmpty(input.columnPath);
  const fromColumns = columnBranch !== null || columnPath !== null;
  const branch = fromColumns ? columnBranch : nonEmpty(out.branchName);
  const path = fromColumns ? columnPath : nonEmpty(out.worktreePath);
  if (branch === null && path === null) return { kind: 'root' };
  return { kind: 'worktree', branch, path };
}
