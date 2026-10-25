import { afterEach, describe, expect, it } from 'vitest';
import { ensureDirNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { nestedRepositoryHead } from './nested-repository.js';
import { gitRun } from './git-exec.js';
import { repoFixture } from '../../test/support/nested-repo.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('nested repository HEAD structure', () => {
  it('never borrows the parent HEAD for an ordinary directory', async () => {
    const { repo, cleanup } = await repoFixture();
    cleanups.push(cleanup);
    await ensureDirNoFollow(repo, 'ordinary');
    expect(await nestedRepositoryHead(repo, 'ordinary')).toBeNull();
  });

  it.each([-1, 124, 128])(
    'refuses a failed HEAD read (exit %s), whatever its wording',
    async (code) => {
      const { repo, cleanup } = await repoFixture();
      cleanups.push(cleanup);
      await ensureDirNoFollow(repo, 'nested');
      await gitRun(repo, ['init', '-q', 'nested']);
      await expect(
        nestedRepositoryHead(repo, 'nested', async () => ({
          code,
          stdout: '',
          stderr: 'no commit checked out',
        })),
      ).rejects.toThrow('HEAD could not be read');
    },
  );

  it('does not treat a malformed successful HEAD read as unborn', async () => {
    const { repo, cleanup } = await repoFixture();
    cleanups.push(cleanup);
    await ensureDirNoFollow(repo, 'nested/.git');
    await writeFileNoFollow(repo, 'nested/.git/HEAD', 'ref: refs/heads/main\n');
    await expect(
      nestedRepositoryHead(repo, 'nested', async () => ({
        code: 0,
        stdout: 'not-a-sha\n',
        stderr: '',
      })),
    ).rejects.toThrow('HEAD could not be read');
  });
});
