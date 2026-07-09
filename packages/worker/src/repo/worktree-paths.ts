/** Where 01-worktree-setup puts a task's feature worktree, relative to the repo root.
 *  Already git-excluded via .git/info/exclude. */
export const WORKTREE_SUBDIR = '.haive/worktrees';

/** The worktree DIRECTORY name for a branch. A namespaced branch (`feature/x`)
 *  flattens its slashes so the on-disk layout stays one level under the subdir; the
 *  branch ref keeps its slash. */
export function worktreeDirName(branch: string): string {
  return branch.replace(/\//g, '-');
}

/** Host + sandbox paths for a worktree directory name. Callers that suffix the name
 *  (`--base` for the transient merge worktree, `--<issue>` for a DAG issue worktree)
 *  build the name themselves and pass it here, so the layout lives in one place. */
export function worktreeDirPaths(
  repoRoot: string,
  sandboxWorkdir: string,
  dirName: string,
): { worktreePath: string; sandboxWorktreePath: string } {
  return {
    worktreePath: `${repoRoot}/${WORKTREE_SUBDIR}/${dirName}`,
    sandboxWorktreePath: `${sandboxWorkdir}/${WORKTREE_SUBDIR}/${dirName}`,
  };
}

/** The feature worktree's path as seen INSIDE a sandbox, where the repo root is
 *  mounted at `sandboxWorkdir`. Derived from the branch so the naming rule lives in
 *  one place — 01-worktree-setup writes the path, resolveTaskSandboxWorkdir rebuilds
 *  it when the step output has been reset. */
export function sandboxWorktreePath(sandboxWorkdir: string, branch: string): string {
  return worktreeDirPaths('', sandboxWorkdir, worktreeDirName(branch)).sandboxWorktreePath;
}
