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

/** Whether git was told not to check some tracked file (assume-unchanged, which core.ignoreStat
 *  sets, or skip-worktree): status never sees an edit there. null when git cannot list them. */
async function hasUncheckedEntries(worktreePath: string): Promise<boolean | null> {
  const listed = await gitRun(worktreePath, ['--no-optional-locks', 'ls-files', '-v', '-z']);
  if (listed.code !== 0) return null;
  return listed.stdout.split('\0').some((entry) => /^([a-z]|S) /.test(entry));
}

/** The worktree's changes no commit holds; null when git cannot say, which is not a clean tree.
 *  One already gone holds none: removal reads absence as success, and a re-driven apply must too. */
export async function readUncommittedChanges(
  worktreePath: string,
  listLimit = 20,
): Promise<UncommittedChanges | null> {
  // A repository that trusts less stat data than git's defaults would hide a same-size rewrite.
  const status = await gitRun(worktreePath, [
    '--no-optional-locks',
    '-c',
    'core.trustctime=true',
    '-c',
    'core.checkStat=default',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  ]);
  if (status.code !== 0) {
    return (await worktreeGone(worktreePath)) ? { count: 0, paths: [] } : null;
  }
  if ((await hasUncheckedEntries(worktreePath)) !== false) return null;
  const entries = parsePorcelainZ(status.stdout);
  return {
    count: entries.length,
    paths: entries.slice(0, listLimit).map((entry) => entry.path),
  };
}
