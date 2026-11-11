import { afterEach, expect, it, vi } from 'vitest';
import * as safeFs from '@haive/shared/fs-safe';
import { git, identity, repoFixture } from '../../test/support/nested-repo.js';
import * as gitExec from './git-exec.js';
import { commitGitPreview, gitPreview } from './git-preview.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const fixture = await repoFixture();
  cleanups.push(fixture.cleanup);
  return fixture.repo;
}

it.each(['deletion', 'rename', 'executable-bit'] as const)(
  'commits a %s and refreshes only its index paths',
  async (kind) => {
    const repo = await setup();
    if (kind === 'deletion') await safeFs.removeNoFollow(repo, 'a.txt');
    if (kind === 'rename') {
      await safeFs.renameNoFollow(repo, 'a.txt', 'renamed.txt');
      await git(repo, ['add', '-A']);
    }
    if (kind === 'executable-bit') await safeFs.chmodNoFollow(repo, 'a.txt', 0o755);
    const preview = await gitPreview(repo);
    expect(preview.paths.sort()).toEqual(kind === 'rename' ? ['a.txt', 'renamed.txt'] : ['a.txt']);
    await safeFs.writeFileNoFollow(repo, 'later.txt', 'unreviewed');
    await git(repo, ['add', '--', 'later.txt']);
    expect(await commitGitPreview(repo, preview, 'reviewed edit', identity)).toBe(true);
    expect((await git(repo, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe(preview.tree);
    const tree = await git(repo, ['ls-tree', 'HEAD']);
    if (kind === 'deletion') expect(tree).not.toContain('a.txt');
    if (kind === 'rename') {
      expect(tree).not.toContain('\ta.txt');
      expect(tree).toContain('\trenamed.txt');
    }
    if (kind === 'executable-bit') expect(tree).toMatch(/^100755 blob .*\ta.txt/m);
    expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('later.txt\n');
    expect(await git(repo, ['diff', '--name-only'])).toBe('');
  },
);

it('surfaces a ref lock failure without claiming the branch changed', async () => {
  const repo = await setup();
  await safeFs.writeFileNoFollow(repo, 'a.txt', 'reviewed');
  const preview = await gitPreview(repo);
  await safeFs.writeFileNoFollow(repo, '.git/refs/heads/main.lock', 'held');
  await expect(commitGitPreview(repo, preview, 'reviewed edit', identity)).rejects.toThrow(
    /git update-ref failed:.*lock/is,
  );
  expect((await git(repo, ['rev-parse', 'HEAD'])).trim()).toBe(preview.head);
});

it('surfaces an update-ref run that gives no answer', async () => {
  const repo = await setup();
  await safeFs.writeFileNoFollow(repo, 'a.txt', 'reviewed');
  const preview = await gitPreview(repo);
  const real = gitExec.gitRun;
  vi.spyOn(gitExec, 'gitRun').mockImplementation(async (...args) =>
    args[1][0] === 'update-ref'
      ? { code: -1, stdout: '', stderr: 'process killed' }
      : real(...args),
  );
  await expect(commitGitPreview(repo, preview, 'reviewed edit', identity)).rejects.toThrow(
    /git update-ref failed:.*process killed/is,
  );
});

it.each([false, true])(
  'cleanup cannot mask the preview result or original error (failed=%s)',
  async (failed) => {
    const repo = await setup();
    const scratchPaths: Parameters<typeof safeFs.removeNoFollow>[] = [];
    vi.spyOn(safeFs, 'removeNoFollow').mockImplementation(async (...args) => {
      scratchPaths.push(args);
      throw new Error('cleanup failed');
    });
    cleanups.push(() => Promise.all(scratchPaths.map((args) => safeFs.removeNoFollow(...args))));
    if (failed) {
      const real = gitExec.gitRun;
      vi.spyOn(gitExec, 'gitRun').mockImplementation(async (...args) =>
        args[1].includes('read-tree')
          ? { code: 128, stdout: '', stderr: 'read-tree failed' }
          : real(...args),
      );
      await expect(gitPreview(repo)).rejects.toThrow(/git preview failed: read-tree failed/);
    } else {
      await expect(gitPreview(repo)).resolves.toMatchObject({ paths: [] });
    }
  },
);

it('skips index refresh and names the landed branch when HEAD switches after update-ref', async () => {
  const repo = await setup();
  await safeFs.writeFileNoFollow(repo, 'a.txt', 'reviewed');
  const preview = await gitPreview(repo);
  await git(repo, ['branch', 'other']);
  const real = gitExec.gitRun;
  let index = '';
  vi.spyOn(gitExec, 'gitRun').mockImplementation(async (...args) => {
    const result = await real(...args);
    if (args[1][0] === 'update-ref' && result.code === 0) {
      await git(repo, ['switch', 'other']);
      await safeFs.writeFileNoFollow(repo, 'a.txt', 'other staged bytes');
      await git(repo, ['add', '--', 'a.txt']);
      index = await git(repo, ['ls-files', '-s']);
    }
    return result;
  });
  await expect(commitGitPreview(repo, preview, 'reviewed edit', identity)).rejects.toThrow(
    /landed on refs\/heads\/main.*branch/s,
  );
  expect(index).not.toBe('');
  expect((await git(repo, ['rev-parse', 'main^{tree}'])).trim()).toBe(preview.tree);
  expect((await git(repo, ['rev-parse', 'other'])).trim()).toBe(preview.head);
  expect(await git(repo, ['ls-files', '-s'])).toBe(index);
});
