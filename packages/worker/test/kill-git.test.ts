import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_NO_EXIT, gitRun } from '../src/repo/git-exec.js';
import { killGit, type KilledGit } from './support/kill-git.js';

const exec = promisify(execFile);

describe('killGit', () => {
  const dirs: string[] = [];
  let shim: KilledGit | null = null;
  afterEach(async () => {
    await shim?.restore();
    shim = null;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function repo(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'kill-git-test-'));
    dirs.push(dir);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    return dir;
  }

  it('ends the matching call with no exit status and leaves the others alone', async () => {
    const dir = await repo();
    shim = await killGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const killed = await gitRun(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(killed.code).toBe(GIT_NO_EXIT);
    expect(killed.noExit).toBe('SIGKILL');
    expect((await gitRun(dir, ['rev-parse', '--is-inside-work-tree'])).code).toBe(0);
    expect((await gitRun(dir, ['status', '--porcelain'])).code).toBe(0);
  });

  it('narrows the match to calls with an argument holding `contains`', async () => {
    const dir = await repo();
    await exec('git', ['commit', '-q', '--allow-empty', '-m', 'one'], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@x',
      },
    });
    shim = await killGit(['rev-parse'], { contains: 'HEAD^{commit}' });
    expect((await gitRun(dir, ['rev-parse', 'HEAD^{commit}'])).code).toBe(GIT_NO_EXIT);
    expect((await gitRun(dir, ['rev-parse', 'HEAD'])).code).toBe(0);
  });

  it('lets `after` matching calls through before it kills', async () => {
    const dir = await repo();
    shim = await killGit(['rev-parse', '--is-inside-work-tree'], { after: 1 });
    expect((await gitRun(dir, ['rev-parse', '--is-inside-work-tree'])).code).toBe(0);
    expect((await gitRun(dir, ['rev-parse', '--is-inside-work-tree'])).code).toBe(GIT_NO_EXIT);
  });

  it('kills only `times` matching calls and answers the rest', async () => {
    const dir = await repo();
    shim = await killGit(['rev-parse', '--is-inside-work-tree'], { times: 1 });
    expect((await gitRun(dir, ['rev-parse', '--is-inside-work-tree'])).code).toBe(GIT_NO_EXIT);
    expect((await gitRun(dir, ['rev-parse', '--is-inside-work-tree'])).code).toBe(0);
    expect((await gitRun(dir, ['rev-parse', '--is-inside-work-tree'])).code).toBe(0);
  });

  it('counts `times` from the calls `after` let through', async () => {
    const dir = await repo();
    shim = await killGit(['rev-parse', '--is-inside-work-tree'], { after: 1, times: 1 });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await gitRun(dir, ['rev-parse', '--is-inside-work-tree'])).code);
    }
    expect(codes).toEqual([0, GIT_NO_EXIT, 0]);
  });
});
