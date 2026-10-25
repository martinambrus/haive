import { gitRun } from './git-exec.js';

/** Commit the whole index, or only the supplied paths after the caller stages them.
 *  Scoped commits leave unrelated staged work alone and refuse an open merge: only a
 *  whole-index commit may conclude it. A failed read is never an empty index, and a
 *  failed commit is never a no-op, regardless of git's display copy. */
export async function gitCommitStaged(
  cwd: string,
  message: string,
  env?: Record<string, string>,
  paths?: readonly string[],
): Promise<boolean> {
  if (paths?.length === 0) throw new Error('git scoped commit requires at least one path');
  const scope = paths ? ['--', ...paths] : [];
  const staged = await gitRun(cwd, [
    'diff',
    '--cached',
    '--quiet',
    '--ignore-submodules=none',
    ...scope,
  ]);
  if (staged.code !== 0 && staged.code !== 1) {
    throw new Error(`git staged read failed: ${staged.stderr || staged.stdout}`);
  }
  if (paths || staged.code === 0) {
    const merge = await gitRun(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    if (merge.code !== 0 && merge.code !== 1) {
      throw new Error(`git merge read failed: ${merge.stderr || merge.stdout}`);
    }
    if (paths && merge.code === 0) {
      throw new Error('git scoped commit refused during an open merge; finish or abort it first');
    }
    if (staged.code === 0 && merge.code === 1) return false;
  }
  const commit = await gitRun(
    cwd,
    ['commit', ...(paths ? ['--only'] : []), '-m', message, ...scope],
    env,
  );
  if (commit.code !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }
  return true;
}
