import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitRun } from '../src/repo/git-exec.js';
import { completeMergeHostSide, mergeCommitted, openMerge } from '../src/step-engine/git-merge.js';

/** What the fixture's own git calls switch off, so only the code under test can leave a marker. */
const QUIET = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A repository whose OWN configuration names a command for every key git will execute: a hook of
 *  each kind Haive's merges and commits reach, a filesystem monitor, an external diff and a
 *  textconv driver. Each writes a marker, so a marker is proof that git ran it. */
async function repoThatNamesCommands(): Promise<{ dir: string; marks: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'haive-git-isolation-'));
  dirs.push(root);
  const dir = path.join(root, 'repo');
  const marks = path.join(root, 'marks');
  await mkdir(dir, { recursive: true });
  await mkdir(marks, { recursive: true });
  const hooks = path.join(dir, 'myhooks');
  await mkdir(hooks, { recursive: true });
  // The fixture builds history with plain git, so it runs the repository's own hooks and monitor
  // too; those two are switched off here so a marker can only come from the code under test.
  const git = (...args: string[]) =>
    execFileSync('git', [...QUIET, ...args], { cwd: dir, stdio: 'pipe' });
  const script = async (file: string, name: string, tail = 'exit 0') => {
    await writeFile(file, `#!/bin/sh\necho ran >> ${marks}/${name}\n${tail}\n`);
    await chmod(file, 0o755);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'isolation@test.local');
  git('config', 'user.name', 'Isolation');
  // A detached `git gc --auto` races the teardown's rm and leaves ENOTEMPTY behind.
  git('config', 'gc.auto', '0');
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-merge-commit']) {
    await script(path.join(hooks, hook), hook);
  }
  await script(path.join(dir, 'fsm.sh'), 'fsmonitor', 'exit 1');
  await script(path.join(dir, 'ext.sh'), 'diff-external');
  await script(path.join(dir, 'tc.sh'), 'textconv', 'cat "$1"');
  git('config', 'core.hooksPath', hooks);
  git('config', 'core.fsmonitor', path.join(dir, 'fsm.sh'));
  git('config', 'diff.external', path.join(dir, 'ext.sh'));
  git('config', 'diff.probe.textconv', path.join(dir, 'tc.sh'));
  await writeFile(path.join(dir, '.gitattributes'), '* diff=probe\n');
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { dir, marks };
}

const ran = async (marks: string): Promise<string[]> => (await readdir(marks)).sort();

describe('a repository that names commands for git to run', () => {
  it('runs none of them through the host git wrapper', async () => {
    const { dir, marks } = await repoThatNamesCommands();
    const git = (...args: string[]) =>
      execFileSync('git', [...QUIET, ...args], { cwd: dir, stdio: 'pipe' });

    // A status, the shape every Haive scan uses.
    expect(await mergeCommitted(dir, 'main')).toBe(true);

    // A clean merge: the merge commit's own hooks.
    git('checkout', '-q', '-b', 'other');
    await writeFile(path.join(dir, 'b.txt'), 'b\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'other');
    git('checkout', '-q', 'main');
    expect(await openMerge(dir, 'other', [], {})).toEqual({ kind: 'merged' });

    // A conflict, resolved the way a fixer's work is completed host-side.
    git('checkout', '-q', '-b', 'conflicting', 'main~1');
    await writeFile(path.join(dir, 'a.txt'), 'theirs\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'theirs');
    git('checkout', '-q', 'main');
    await writeFile(path.join(dir, 'a.txt'), 'ours\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'ours');
    expect(await openMerge(dir, 'conflicting', [], {})).toEqual({ kind: 'conflict' });
    await writeFile(path.join(dir, 'a.txt'), 'resolved\n');
    expect(await completeMergeHostSide(dir, {}, 'conflicting')).toBe(true);

    // A patch-producing diff, where an external helper and a textconv driver run.
    const diff = await gitRun(dir, ['diff', 'HEAD~1', '--', 'a.txt']);
    expect([diff.code, diff.stderr]).toEqual([0, '']);
    expect(diff.stdout).toContain('@@');

    expect(await ran(marks)).toEqual([]);
  });

  it('runs every one of them under plain git, so the fixture is live', async () => {
    const { dir, marks } = await repoThatNamesCommands();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
    await writeFile(path.join(dir, 'c.txt'), 'c\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'plain');
    git('--no-optional-locks', 'status', '--porcelain');
    await writeFile(path.join(dir, 'c.txt'), 'c2\n');
    git('diff', '--', 'c.txt');
    const marksFound = await ran(marks);
    for (const name of ['commit-msg', 'diff-external', 'fsmonitor', 'pre-commit']) {
      expect(marksFound).toContain(name);
    }
  });

  it('keeps the commit message a hook would have rewritten', async () => {
    const { dir } = await repoThatNamesCommands();
    const hooks = path.join(dir, 'myhooks');
    await writeFile(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho rewritten > "$1"\n');
    await chmod(path.join(hooks, 'commit-msg'), 0o755);
    await writeFile(path.join(dir, 'd.txt'), 'd\n');
    expect((await gitRun(dir, ['add', '-A'])).code).toBe(0);
    expect((await gitRun(dir, ['commit', '-m', 'ISSUE-1: keep me'])).code).toBe(0);
    const subject = await gitRun(dir, ['log', '-1', '--format=%s']);
    expect(subject.stdout.trim()).toBe('ISSUE-1: keep me');
  });
});
