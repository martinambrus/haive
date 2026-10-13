import { isAbsolute, relative } from 'node:path';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { gitRun } from './git-exec.js';

/** Whether a merge or rebase is open: the pseudoref FILE exists. `rev-parse --verify` would also
 *  resolve a branch or tag that happens to be named MERGE_HEAD or REBASE_HEAD. */
export async function gitOperationInProgress(repoPath: string): Promise<boolean> {
  for (const ref of ['MERGE_HEAD', 'REBASE_HEAD']) {
    const located = await gitRun(repoPath, ['rev-parse', '--git-path', ref]);
    if (located.code !== 0) continue;
    const path = located.stdout.trim();
    if (!path) continue;
    const rel = isAbsolute(path) ? relative(repoPath, path) : path;
    // A git dir outside the checkout cannot be read from its anchor; treat it as open, which writes nothing.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return true;
    if ((await lstatNoFollow(repoPath, rel)) !== null) return true;
  }
  return false;
}
