import { afterEach, expect, it, vi } from 'vitest';
import * as safeFs from '@haive/shared/fs-safe';
import { git, identity, repoFixture } from '../../test/support/nested-repo.js';
import * as gitExec from './git-exec.js';
import { GitPreviewHiddenEntriesError, commitGitPreview, gitPreview } from './git-preview.js';
import { buildCommitDiffArtifact } from '../step-engine/steps/workflow/_commit-diff.js';

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

it('keeps an ignored file removed from the index out of the pinned tree', async () => {
  const repo = await setup();
  await safeFs.writeFileNoFollow(repo, '.env', 'previously public\n');
  await safeFs.writeFileNoFollow(repo, '.gitignore', '.env\n');
  await git(repo, ['add', '-f', '--', '.env', '.gitignore']);
  await git(repo, ['commit', '-qm', 'track env']);
  await git(repo, ['rm', '--cached', '--', '.env']);
  await safeFs.writeFileNoFollow(repo, '.env', 'SECRET_CURRENT_BYTES\n');
  expect(await git(repo, ['status', '--porcelain'])).toBe('D  .env\n');
  const index = await git(repo, ['ls-files', '-s']);
  await buildCommitDiffArtifact(repo, gitExec.gitRun);
  const artifact = JSON.parse(
    (await safeFs.readFileNoFollow(repo, '.haive/gate3-diff.json'))!.data.toString('utf8'),
  );
  expect(artifact.files).toEqual([
    expect.objectContaining({ path: '.env', status: 'deleted', newContent: '' }),
  ]);
  expect(JSON.stringify(artifact)).not.toContain('SECRET_CURRENT_BYTES');

  const preview = await gitPreview(repo);
  expect(await git(repo, ['ls-files', '-s'])).toBe(index);
  expect(preview.paths).toEqual(['.env']);
  expect(await git(repo, ['ls-tree', '--name-only', preview.tree, '--', '.env'])).toBe('');
  await git(repo, ['add', '-A']);
  expect(preview.tree).toBe((await git(repo, ['write-tree'])).trim());
  expect(await commitGitPreview(repo, preview, 'stop tracking env', identity)).toBe(true);
  expect(await git(repo, ['ls-tree', '--name-only', 'HEAD', '--', '.env'])).toBe('');
});

it('pins an ordinary edit and new file while preserving a staged deletion', async () => {
  const repo = await setup();
  await safeFs.writeFileNoFollow(repo, 'deleted.txt', 'delete me\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'add deletion fixture']);
  await git(repo, ['rm', '--', 'deleted.txt']);
  await safeFs.writeFileNoFollow(repo, 'a.txt', 'ordinary edit\n');
  await safeFs.writeFileNoFollow(repo, 'new.txt', 'ordinary new file\n');
  const preview = await gitPreview(repo);
  expect(preview.paths).toEqual(['a.txt', 'deleted.txt', 'new.txt']);
  expect(await git(repo, ['show', `${preview.tree}:a.txt`])).toBe('ordinary edit\n');
  expect(await git(repo, ['show', `${preview.tree}:new.txt`])).toBe('ordinary new file\n');
  expect(await git(repo, ['ls-tree', '--name-only', preview.tree, '--', 'deleted.txt'])).toBe('');
  await git(repo, ['add', '-A']);
  expect(preview.tree).toBe((await git(repo, ['write-tree'])).trim());
});

it.each(['--assume-unchanged', '--skip-worktree'])(
  'refuses a preview whose scope holds an entry hidden by %s',
  async (flag) => {
    const repo = await setup();
    await safeFs.writeFileNoFollow(repo, 'a.txt', 'staged bytes\n');
    await git(repo, ['add', '--', 'a.txt']);
    await git(repo, ['update-index', flag, '--', 'a.txt']);
    await safeFs.writeFileNoFollow(repo, 'a.txt', 'hidden bytes\n');
    const index = await git(repo, ['ls-files', '-v', '-s']);
    for (const scope of [['a.txt'], undefined])
      await expect(gitPreview(repo, scope)).rejects.toBeInstanceOf(GitPreviewHiddenEntriesError);
    expect(await git(repo, ['ls-files', '-v', '-s'])).toBe(index);
  },
);

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

it('commits from a detached checkout and refuses once a branch is checked out', async () => {
  const repo = await setup();
  await git(repo, ['switch', '--detach']);
  await safeFs.writeFileNoFollow(repo, 'a.txt', 'detached edit');
  const detached = await gitPreview(repo);
  expect(detached.ref).toBe('HEAD');
  expect(await commitGitPreview(repo, detached, 'detached edit', identity)).toBe(true);
  expect((await git(repo, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe(detached.tree);

  await safeFs.writeFileNoFollow(repo, 'a.txt', 'second edit');
  const second = await gitPreview(repo);
  await git(repo, ['switch', '-c', 'attached']);
  await expect(commitGitPreview(repo, second, 'second edit', identity)).rejects.toThrow(
    /branch changed since the commit preview/,
  );
  expect((await git(repo, ['rev-parse', 'attached'])).trim()).toBe(second.head);
});
