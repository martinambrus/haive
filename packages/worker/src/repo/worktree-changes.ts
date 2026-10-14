import { lstatNoFollow } from '@haive/shared/fs-safe';
import { parsePorcelainZ } from '../step-engine/steps/workflow/_commit-diff.js';
import { gitRun } from './git-exec.js';
import { splitWorktreePath } from './worktree-paths.js';

export interface UncommittedChanges {
  /** What `git status` lists; a wholly untracked directory is one entry. */
  count: number;
  /** The first `listLimit` of them, in git's order. */
  paths: string[];
}

export const describeChanges = (n: number): string =>
  `${n} uncommitted change${n === 1 ? '' : 's'}`;

/** Whether nothing stands at the worktree's path. Only a read that proves absence says yes. */
async function worktreeGone(worktreePath: string): Promise<boolean> {
  const split = splitWorktreePath(worktreePath);
  if (!split) return false;
  try {
    return (await lstatNoFollow(split.anchor, split.rel, { strict: true })) === null;
  } catch {
    return false;
  }
}

/** The worktree's changes no commit holds; null when git cannot say, which is not a clean tree.
 *  One already gone holds none: removal reads absence as success, and a re-driven apply must too. */
export async function readUncommittedChanges(
  worktreePath: string,
  listLimit = 20,
): Promise<UncommittedChanges | null> {
  const status = await gitRun(worktreePath, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  ]);
  if (status.code !== 0) {
    return (await worktreeGone(worktreePath)) ? { count: 0, paths: [] } : null;
  }
  const entries = parsePorcelainZ(status.stdout);
  return {
    count: entries.length,
    paths: entries.slice(0, listLimit).map((entry) => entry.path),
  };
}
