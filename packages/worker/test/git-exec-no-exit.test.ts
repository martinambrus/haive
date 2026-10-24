import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_NO_EXIT, GIT_TIMED_OUT, gitGaveNoAnswer, gitRun } from '../src/repo/git-exec.js';

const exec = promisify(execFile);
const dirs: string[] = [];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.trim();
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('gitRun when git ends without an exit status', () => {
  it('a missing cwd is GIT_NO_EXIT, not exit 1', async () => {
    const cwd = path.join(await scratch('no-exit-cwd-'), 'never-created');
    const res = await gitRun(cwd, ['status']);
    expect(res.code).toBe(GIT_NO_EXIT);
    expect(res.code).not.toBe(1);
    expect(res.noExit).toBe('ENOENT');
    expect(res.stderr).toContain(cwd);
    expect(res.stderr).toContain('ENOENT');
  });

  it('an output overflow is GIT_NO_EXIT', async () => {
    const res = await gitRun(tmpdir(), ['--version'], undefined, { maxBuffer: 4 });
    expect(res.code).toBe(GIT_NO_EXIT);
    expect(res.noExit).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });

  it('a git killed by a signal other than the time limit is GIT_NO_EXIT', async () => {
    const bin = await scratch('no-exit-bin-');
    await writeFile(path.join(bin, 'git'), '#!/bin/sh\nkill -9 $$\n');
    await chmod(path.join(bin, 'git'), 0o755);
    const res = await gitRun(tmpdir(), ['status'], { PATH: bin });
    expect(res.code).toBe(GIT_NO_EXIT);
    expect(res.noExit).toBe('SIGKILL');
  });

  it('real exit statuses are untouched', async () => {
    const dir = await scratch('no-exit-repo-');
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'gc.auto', '0']);
    await git(dir, ['commit', '--allow-empty', '-m', 'one']);
    const a = await git(dir, ['rev-parse', 'HEAD']);
    await git(dir, ['checkout', '--orphan', 'other']);
    await git(dir, ['commit', '--allow-empty', '-m', 'two']);
    const b = await git(dir, ['rev-parse', 'HEAD']);

    const notAncestor = await gitRun(dir, ['merge-base', '--is-ancestor', a, b]);
    expect(notAncestor.code).toBe(1);
    expect(notAncestor.noExit).toBeUndefined();
    expect(notAncestor.stderr).not.toContain('ended without');

    const missing = await gitRun(dir, ['rev-parse', '--verify', 'nope']);
    expect(missing.code).toBe(128);
    expect(missing.noExit).toBeUndefined();
    expect(missing.stderr).not.toContain('ended without');
  });
});

describe('gitGaveNoAnswer', () => {
  it('is true for a run with no exit status and for one killed at its time limit', async () => {
    const cwd = path.join(await scratch('no-answer-cwd-'), 'never-created');
    expect(gitGaveNoAnswer(await gitRun(cwd, ['status']))).toBe(true);

    const bin = await scratch('no-answer-bin-');
    await writeFile(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n');
    await chmod(path.join(bin, 'git'), 0o755);
    const slow = await gitRun(
      tmpdir(),
      ['status'],
      { PATH: `${bin}:${process.env.PATH}` },
      { timeout: 100 },
    );
    expect(slow.code).toBe(GIT_TIMED_OUT);
    expect(gitGaveNoAnswer(slow)).toBe(true);
  });

  it('is false for every real exit status', async () => {
    const dir = await scratch('no-answer-repo-');
    await git(dir, ['init', '-b', 'main']);
    expect(gitGaveNoAnswer(await gitRun(dir, ['status']))).toBe(false);
    expect(gitGaveNoAnswer(await gitRun(dir, ['rev-parse', '--verify', '--quiet', 'nope']))).toBe(
      false,
    );
    expect(gitGaveNoAnswer(await gitRun(dir, ['rev-parse', '--verify', 'nope']))).toBe(false);
  });
});
