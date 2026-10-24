import { isAbsolute, relative } from 'node:path';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { gitRun } from './git-exec.js';
import { gitWorkspaceStatus } from './git-workspace.js';

/** A checkout with a `.git` whose merge or rebase state could not be read. */
export class GitOperationUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitOperationUnreadableError';
  }
}

/** Whether a merge or rebase is open: its state entry in the git dir exists. `rev-parse --verify`
 *  would also resolve a branch or tag named MERGE_HEAD; a rebase stopped at an `exec` has its state
 *  directory but no REBASE_HEAD. A checkout with no `.git` has none; a read that fails in one that has
 *  a `.git` is unknown and throws. */
export async function gitOperationInProgress(repoPath: string): Promise<boolean> {
  for (const ref of ['MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply']) {
    const located = await gitRun(repoPath, ['rev-parse', '--git-path', ref]);
    if (located.code !== 0) {
      if ((await gitWorkspaceStatus(repoPath)) === 'absent') return false;
      throw new GitOperationUnreadableError(
        `git rev-parse --git-path ${ref} failed in ${repoPath}: ${(located.stderr || located.stdout).trim().slice(0, 500)}`,
      );
    }
    const path = located.stdout.trim();
    if (!path) continue;
    const rel = isAbsolute(path) ? relative(repoPath, path) : path;
    // A git dir outside the checkout cannot be read from its anchor; treat it as open, which writes nothing.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return true;
    try {
      if ((await lstatNoFollow(repoPath, rel, { strict: true })) !== null) return true;
    } catch (err) {
      throw new GitOperationUnreadableError(
        `${ref} could not be read in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return false;
}
