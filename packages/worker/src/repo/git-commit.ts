import { gitRun } from './git-exec.js';

/** Stage the safe on-disk roots plus tracked deletions, and return the commit scope.
 *  Callers distinguish absent roots from rejected entries (such as symlinks). An absent
 *  root still in the index needs `add`; an already-staged whole-root deletion belongs
 *  only in the commit scope, since `add` rejects a path no longer on disk or in the index.
 *  Never pass a never-tracked missing root to either mutating command. */
export async function gitStageScopedPaths(
  cwd: string,
  present: readonly string[],
  absent: readonly string[],
): Promise<string[]> {
  const stage = [...present];
  const scope = [...present];
  for (const path of absent) {
    const tracked = await gitRun(cwd, ['ls-files', '--cached', '-z', '--', path]);
    if (tracked.code !== 0) {
      throw new Error(`git tracked paths read failed: ${tracked.stderr || tracked.stdout}`);
    }
    if (tracked.stdout.length > 0) {
      stage.push(path);
      scope.push(path);
      continue;
    }
    const staged = await gitRun(cwd, [
      'diff',
      '--cached',
      '--quiet',
      '--ignore-submodules=none',
      '--',
      path,
    ]);
    if (staged.code === 1) scope.push(path);
    else if (staged.code !== 0) {
      throw new Error(`git staged read failed: ${staged.stderr || staged.stdout}`);
    }
  }
  if (stage.length > 0) {
    const add = await gitRun(cwd, ['add', '--', ...stage]);
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);
  }
  return scope;
}

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
