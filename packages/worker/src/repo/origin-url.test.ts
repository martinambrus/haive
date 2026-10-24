import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { gitRun } from './git-exec.js';
import { detectOrigin, getOriginUrl, pushBranch } from './git-push.js';
import { fetchOrigin } from '../plan/merge.js';

const dirs: string[] = [];
const db = {} as Database;
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function repo(bare = false): Promise<string> {
  const dir = await mkdtemp('/tmp/t388-origin-');
  dirs.push(dir);
  expect((await gitRun(dir, ['init', ...(bare ? ['--bare'] : []), '-b', 'main'])).code).toBe(0);
  if (!bare) {
    expect(
      (
        await gitRun(dir, [
          '-c',
          'user.name=T',
          '-c',
          'user.email=t@example.test',
          'commit',
          '--allow-empty',
          '-m',
          'seed',
        ])
      ).code,
    ).toBe(0);
  }
  return dir;
}
describe('origin URL boundary', () => {
  it.each(['url', 'pushurl'])(
    'refuses a local %s before a helper reaches the second repository',
    async (key) => {
      const work = await repo();
      const target = await repo(true);
      await gitRun(work, [
        'remote',
        'add',
        'origin',
        key === 'url' ? target : 'https://example.test/r',
      ]);
      if (key === 'pushurl') await gitRun(work, ['config', 'remote.origin.pushurl', target]);
      if (key === 'url') await gitRun(work, ['push', target, 'main']);
      const operation =
        key === 'pushurl'
          ? pushBranch({ cwd: work, branch: 'main', setUpstream: false, db, userId: 'u' })
          : fetchOrigin({ repoPath: work, branch: 'main', db, userId: 'u' });
      await expect(operation).rejects.toMatchObject({ name: 'OriginUrlError' });
      if (key === 'pushurl')
        expect(
          (await gitRun(target, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'])).code,
        ).toBe(1);
    },
  );
  it.each(['url', 'pushurl'])('checks every %s including a second unsafe value', async (key) => {
    const work = await repo();
    await gitRun(work, ['remote', 'add', 'origin', 'https://example.test/r']);
    if (key === 'pushurl')
      await gitRun(work, ['config', '--add', 'remote.origin.pushurl', 'ssh://git@example.test/r']);
    await gitRun(work, ['config', '--add', `remote.origin.${key}`, '/tmp/other-user']);
    await expect(getOriginUrl(work)).rejects.toMatchObject({ name: 'OriginUrlError' });
    await expect(detectOrigin(work)).rejects.toThrow('/tmp/other-user');
  });
  it('validates the rewritten URL git actually uses', async () => {
    const work = await repo();
    await gitRun(work, ['remote', 'add', 'origin', 'https://example.test/r']);
    await gitRun(work, ['config', 'url./tmp/other-user.insteadOf', 'https://example.test/']);
    await expect(getOriginUrl(work)).rejects.toMatchObject({ name: 'OriginUrlError' });
  });
  it.each(['file://user:secret@host/repo', 'ext://user:secret@host/repo'])(
    'removes userinfo from refused URL %s',
    async (url) => {
      const work = await repo();
      await gitRun(work, ['remote', 'add', 'origin', url]);
      await expect(getOriginUrl(work)).rejects.toThrow(/origin.*URL.*not allowed/i);
      await getOriginUrl(work).catch((e: Error) => {
        expect(e.message).not.toContain('user');
        expect(e.message).not.toContain('secret');
        expect(e.message).toContain('host/repo');
      });
    },
  );
  it('accepts all allowed fetch/push addresses and returns the first fetch URL', async () => {
    const work = await repo();
    await gitRun(work, ['remote', 'add', 'origin', 'https://example.test/r']);
    await gitRun(work, ['config', '--add', 'remote.origin.url', 'http://example.test/r']);
    await gitRun(work, ['config', '--add', 'remote.origin.pushurl', 'git@example.test:r']);
    await gitRun(work, ['config', '--add', 'remote.origin.pushurl', 'ssh://git@example.test/r']);
    expect(await getOriginUrl(work)).toBe('https://example.test/r');
  });
});
