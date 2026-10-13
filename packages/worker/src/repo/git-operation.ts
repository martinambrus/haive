import { gitRun } from './git-exec.js';

export async function gitOperationInProgress(repoPath: string): Promise<boolean> {
  for (const ref of ['MERGE_HEAD', 'REBASE_HEAD']) {
    if ((await gitRun(repoPath, ['rev-parse', '-q', '--verify', ref])).code === 0) return true;
  }
  return false;
}
