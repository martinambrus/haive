import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { RepoJobPayload } from '@haive/shared';
import { fastForward } from './refresh.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, env: GIT_ENV });
}

const db = {} as unknown as Database;
const payload = { source: 'github', repositoryId: 'r1', userId: 'u1' } as unknown as RepoJobPayload;

describe('fastForward remote probe', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function repo(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'rr-'));
    dirs.push(dir);
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'gc.auto', '0']);
    await git(dir, ['commit', '--allow-empty', '-m', 'one']);
    return dir;
  }

  it('says it could not read an unreadable remote', async () => {
    const dir = await repo();
    await git(dir, ['remote', 'add', 'origin', 'https://example.com/x.git']);
    await git(dir, ['config', '--add', 'remote.origin.fetch', ':::bad']);
    expect(await fastForward(db, payload, dir)).toMatch(
      /^Not refreshed: could not read the remote \(/,
    );
  });

  it('says there is no remote when there is none', async () => {
    const dir = await repo();
    expect(await fastForward(db, payload, dir)).toBe(
      'Nothing to refresh from: this repository has no remote.',
    );
  });

  it('stops on a detached HEAD before it looks at the remote', async () => {
    const dir = await repo();
    await git(dir, ['checkout', '--detach']);
    expect(await fastForward(db, payload, dir)).toBe(
      'Not refreshed: the checkout is not on a branch.',
    );
  });
});
