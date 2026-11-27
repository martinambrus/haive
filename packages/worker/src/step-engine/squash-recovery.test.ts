import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitTemplate } from '../../test/support/git-template.js';
import { squashMergeCommit } from './git-merge.js';

const h = vi.hoisted(() => ({ crashAfter: '' }));
vi.mock('../repo/git-push.js', async (original) => {
  const actual = await original<typeof import('../repo/git-push.js')>();
  return {
    ...actual,
    gitRun: async (...args: Parameters<typeof actual.gitRun>) => {
      const result = await actual.gitRun(...args);
      if (result.code === 0 && args[1][0] === h.crashAfter) {
        h.crashAfter = '';
        throw new Error('worker died after Git write');
      }
      return result;
    },
  };
});
afterEach(() => {
  h.crashAfter = '';
});
const exec = promisify(execFile);
const identity = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@test.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@test.local',
};
async function git(dir: string, ...args: string[]) {
  return (
    await exec('git', args, { cwd: dir, env: { ...process.env, ...identity } })
  ).stdout.trim();
}
const template = gitTemplate(async (dir) => {
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'gc.auto', '0');
  await git(dir, 'config', 'maintenance.auto', 'false');
  await writeFile(path.join(dir, 'base'), 'base\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'base');
  const before = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'switch', '-c', 'feature');
  await writeFile(path.join(dir, 'feature'), 'feature\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'feature');
  await git(dir, 'switch', 'main');
  await git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge');
  return {
    before,
    merge: await git(dir, 'rev-parse', 'HEAD'),
    tree: await git(dir, 'rev-parse', 'HEAD^{tree}'),
  };
});

describe('T316 squash recovery', () => {
  it.each([false, true])(
    'member 2: preserves a squash and subsequent personal commit (recorded=%s)',
    async (recorded) => {
      const { dir, data } = await template.copy();
      await git(dir, 'reset', '--soft', data.before);
      await git(dir, 'commit', '-m', 'squash made before crash');
      const squash = await git(dir, 'rev-parse', 'HEAD');
      await writeFile(path.join(dir, 'personal'), 'personal work\n');
      await git(dir, 'add', '.');
      await git(dir, 'commit', '-m', 'personal commit after crash');
      const head = await git(dir, 'rev-parse', 'HEAD');
      const reflog = await git(dir, 'reflog', '--format=%H %gs');
      const skipped = vi.fn();
      expect(
        await squashMergeCommit(
          dir,
          data.before,
          'retry',
          identity,
          'feature',
          skipped,
          recorded ? data.merge : undefined,
        ),
      ).toBeNull();
      expect(skipped).toHaveBeenCalledWith(expect.stringContaining('Squash skipped'));
      expect(await git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect(await git(dir, 'rev-parse', 'HEAD^')).toBe(squash);
      expect(await git(dir, 'rev-parse', 'HEAD^^')).toBe(data.before);
      expect(await git(dir, 'show', 'HEAD:feature')).toBe('feature');
      expect(await git(dir, 'show', 'HEAD:personal')).toBe('personal work');
      expect(await git(dir, 'status', '--porcelain')).toBe('');
      expect(await git(dir, 'reflog', '--format=%H %gs')).toBe(reflog);
    },
  );

  it.each(['reset', 'commit'])(
    'member 3: recovers a crash after %s without ORIG_HEAD using the recorded merge',
    async (point) => {
      const { dir, data } = await template.copy();
      h.crashAfter = point;
      await expect(
        squashMergeCommit(dir, data.before, 'squash', identity, 'feature', undefined, data.merge),
      ).rejects.toThrow('worker died after Git write');
      // ORIG_HEAD is mutable Git scratch state, not the persisted merge identity.
      await git(dir, 'update-ref', '-d', 'ORIG_HEAD');
      // Recorded evidence must also take precedence over containment of a moved feature ref.
      await git(dir, 'update-ref', 'refs/heads/feature', data.before);
      const head = await git(dir, 'rev-parse', 'HEAD');
      const reflog = await git(dir, 'reflog', '--format=%H %gs');
      const recovered = await squashMergeCommit(
        dir,
        data.before,
        'retry',
        identity,
        'feature',
        undefined,
        data.merge,
      );
      expect(recovered).toBe(await git(dir, 'rev-parse', 'HEAD'));
      expect(await git(dir, 'rev-parse', 'HEAD^')).toBe(data.before);
      expect(await git(dir, 'rev-parse', 'HEAD^{tree}')).toBe(data.tree);
      expect(await git(dir, 'rev-list', '--count', 'HEAD')).toBe('2');
      expect(await git(dir, 'status', '--porcelain')).toBe('');
      if (point === 'commit') {
        expect(recovered).toBe(head);
        expect(await git(dir, 'reflog', '--format=%H %gs')).toBe(reflog);
      }
    },
  );

  it.each(['reset', 'commit'])(
    'member 3: ignores an overwritten ORIG_HEAD after %s',
    async (point) => {
      const { dir, data } = await template.copy();
      await git(dir, 'reset', '--soft', data.before);
      if (point === 'commit') await git(dir, 'commit', '-m', 'squash');
      // A no-op soft reset legitimately overwrites ORIG_HEAD with the current tip.
      await git(dir, 'reset', '--soft', 'HEAD');
      const head = await git(dir, 'rev-parse', 'HEAD');
      expect(await git(dir, 'rev-parse', 'ORIG_HEAD')).toBe(head);
      const recovered = await squashMergeCommit(
        dir,
        data.before,
        'retry',
        identity,
        'feature',
        undefined,
        data.merge,
      );
      expect(recovered).toBe(await git(dir, 'rev-parse', 'HEAD'));
      expect(await git(dir, 'rev-parse', 'HEAD^')).toBe(data.before);
      expect(await git(dir, 'rev-parse', 'HEAD^{tree}')).toBe(data.tree);
      if (point === 'commit') expect(recovered).toBe(head);
    },
  );

  it.each(['reset', 'commit'])(
    'member 3 control: rejects a mismatched recorded first parent after %s without moving HEAD',
    async (point) => {
      const { dir, data } = await template.copy();
      // Same merge tree, different base: only the first-parent proof can reject it.
      const foreignBase = await git(
        dir,
        'commit-tree',
        data.tree,
        '-p',
        data.before,
        '-m',
        'foreign base',
      );
      await git(dir, 'reset', '--soft', foreignBase);
      if (point === 'commit') await git(dir, 'commit', '--allow-empty', '-m', 'foreign squash');
      await git(dir, 'update-ref', '-d', 'ORIG_HEAD');
      const head = await git(dir, 'rev-parse', 'HEAD');
      const reflog = await git(dir, 'reflog', '--format=%H %gs');
      await expect(
        squashMergeCommit(dir, foreignBase, 'unsafe', identity, 'feature', undefined, data.merge),
      ).rejects.toThrow('merge first parent differs');
      expect(await git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect(await git(dir, 'write-tree')).toBe(data.tree);
      expect(await git(dir, 'reflog', '--format=%H %gs')).toBe(reflog);
    },
  );

  it('member 3 control: skips a stale recorded merge after the feature is remerged', async () => {
    const { dir, data } = await template.copy();
    await git(dir, 'switch', 'feature');
    await writeFile(path.join(dir, 'later'), 'later feature work\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'later feature');
    await git(dir, 'switch', 'main');
    await git(dir, 'reset', '--hard', data.before);
    await git(dir, 'merge', '--no-ff', 'feature', '-m', 'replacement merge');
    const head = await git(dir, 'rev-parse', 'HEAD');
    const tree = await git(dir, 'write-tree');
    const reflog = await git(dir, 'reflog', '--format=%H %gs');
    const skipped = vi.fn();
    expect(
      await squashMergeCommit(dir, data.before, 'unsafe', identity, 'feature', skipped, data.merge),
    ).toBeNull();
    expect(skipped).toHaveBeenCalledWith(expect.stringContaining('not the recorded feature merge'));
    expect(await git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(dir, 'write-tree')).toBe(tree);
    expect(await git(dir, 'reflog', '--format=%H %gs')).toBe(reflog);
  });

  it('member 3 control: an unreadable recorded merge names the missing object as the remedy', async () => {
    const { dir, data } = await template.copy();
    await git(dir, 'reset', '--soft', data.before);
    const missing = 'a'.repeat(40);
    const reflog = await git(dir, 'reflog', '--format=%H %gs');
    await expect(
      squashMergeCommit(dir, data.before, 'unsafe', identity, 'feature', undefined, missing),
    ).rejects.toThrow(`restore the recorded feature merge object ${missing}`);
    expect(await git(dir, 'rev-parse', 'HEAD')).toBe(data.before);
    expect(await git(dir, 'write-tree')).toBe(data.tree);
    expect(await git(dir, 'reflog', '--format=%H %gs')).toBe(reflog);
  });

  it('member 3 control: a legacy reset without ORIG_HEAD has no proof and remains untouched', async () => {
    const { dir, data } = await template.copy();
    await git(dir, 'reset', '--soft', data.before);
    await git(dir, 'update-ref', '-d', 'ORIG_HEAD');
    await expect(
      squashMergeCommit(dir, data.before, 'unsafe', identity, 'feature'),
    ).rejects.toThrow('Cannot resume squash');
    expect(await git(dir, 'rev-parse', 'HEAD')).toBe(data.before);
    expect(await git(dir, 'write-tree')).toBe(data.tree);
  });

  it.each(['reset', 'commit'])(
    'member 3 control: rejects a different %s tree even with a recorded merge',
    async (point) => {
      const { dir, data } = await template.copy();
      await git(dir, 'reset', '--soft', data.before);
      await writeFile(path.join(dir, 'other'), 'not part of the merge\n');
      await git(dir, 'add', '.');
      if (point === 'commit') await git(dir, 'commit', '-m', 'different squash');
      await git(dir, 'update-ref', '-d', 'ORIG_HEAD');
      const head = await git(dir, 'rev-parse', 'HEAD');
      const tree = await git(dir, 'write-tree');
      const reflog = await git(dir, 'reflog', '--format=%H %gs');
      await expect(
        squashMergeCommit(dir, data.before, 'unsafe', identity, 'feature', undefined, data.merge),
      ).rejects.toThrow('Cannot resume squash');
      expect(await git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect(await git(dir, 'write-tree')).toBe(tree);
      expect(await git(dir, 'reflog', '--format=%H %gs')).toBe(reflog);
    },
  );
});
