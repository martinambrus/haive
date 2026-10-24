import { gitRun } from './git-exec.js';

/** Commit the whole index only when git confirms it has changes. A failed read is never
 *  an empty index, and a failed commit is never a no-op, regardless of git's display copy. */
export async function gitCommitStaged(
  cwd: string,
  message: string,
  env?: Record<string, string>,
): Promise<boolean> {
  const staged = await gitRun(cwd, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return false;
  if (staged.code !== 1) {
    throw new Error(`git staged read failed: ${staged.stderr || staged.stdout}`);
  }
  const commit = await gitRun(cwd, ['commit', '-m', message], env);
  if (commit.code !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }
  return true;
}
