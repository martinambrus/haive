import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { chownNoFollow, lstatNoFollow } from '@haive/shared/fs-safe';
import { gitTemplate } from './support/git-template.js';
import { git } from './support/projection-fixture.js';
import {
  captureFixBaseline,
  handBackAfterMove,
  relocateFixerChanges,
} from '../src/step-engine/git-merge.js';

const fault = vi.hoisted(() => ({ rel: '', code: '' }));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    lstatNoFollow: async (...args: Parameters<typeof real.lstatNoFollow>) => {
      if (fault.code && args[1] === fault.rel) {
        const error = Object.assign(new Error('arbitrary stat diagnostic'), { code: fault.code });
        // Model the real primitive: a lenient read folds errno into null.
        if (!args[2]?.strict) return null;
        throw error;
      }
      const entry = await real.lstatNoFollow(...args);
      return entry && args[1] === 'conflict'
        ? { ...entry, stats: { ...entry.stats, uid: 0 } }
        : entry;
    },
    chownNoFollow: vi.fn(async () => {}),
  };
});
afterEach(() => {
  fault.code = '';
  vi.restoreAllMocks();
});
const template = gitTemplate(async (dir) => {
  await git(dir, ['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'conflict'), 'base\n');
  await writeFile(join(dir, 'outside'), 'original\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'base']);
  const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  await git(dir, ['checkout', '-qb', 'feature']);
  await writeFile(join(dir, 'conflict'), 'incoming\n');
  await git(dir, ['commit', '-qam', 'incoming']);
  await git(dir, ['checkout', '-q', 'main']);
  await writeFile(join(dir, 'conflict'), 'local\n');
  await git(dir, ['commit', '-qam', 'local']);
  return before;
});

it.each(['EACCES', 'EMFILE'])(
  'strict hand-back refuses an unknown path (%s), and retry succeeds',
  async (code) => {
    const { dir, data: before } = await template.copy();
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    fault.rel = 'conflict';
    fault.code = code;
    await expect(handBackAfterMove(dir, before, true)).rejects.toMatchObject({
      code: 'MERGE_HAND_BACK_FAILED',
    });
    fault.code = '';
    await expect(handBackAfterMove(dir, before, true)).resolves.toBeUndefined();
  },
);

it.each(['EACCES', 'EMFILE'])(
  'fixer relocation refuses an unreadable owner (%s) before moving or restoring bytes',
  async (code) => {
    const { dir } = await template.copy();
    await git(dir, ['merge', '--no-ff', '--no-edit', 'feature']).catch(() => {});
    const baseline = await captureFixBaseline(dir, async () => null);
    expect(baseline).toHaveProperty('tree');
    await writeFile(join(dir, 'outside'), 'fixer edit\n');
    const index = await git(dir, ['ls-files', '-s', '-z']);
    fault.rel = '';
    fault.code = code;
    await expect(
      relocateFixerChanges(dir, baseline, { taskId: 'task', runId: 'run' }, async () => null),
    ).rejects.toMatchObject({ code: 'MERGE_OWNER_UNREADABLE' });
    expect(await readFile(join(dir, 'outside'), 'utf8')).toBe('fixer edit\n');
    expect(await git(dir, ['ls-files', '-s', '-z'])).toBe(index);
    fault.code = '';
    const result = await relocateFixerChanges(
      dir,
      baseline,
      { taskId: 'task', runId: 'run' },
      async () => null,
    );
    expect(result?.moved).toContain('outside');
    expect(await readFile(join(dir, 'outside'), 'utf8')).toBe('original\n');
  },
);

it('a positively deleted path needs no hand-back', async () => {
  const { dir, data: before } = await template.copy();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  await git(dir, ['rm', '-f', '--', 'conflict']);
  await expect(handBackAfterMove(dir, before, true)).resolves.toBeUndefined();
});

it('a directory replaced by a symlink needs no hand-back through the link', async () => {
  const { dir } = await template.copy();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  await mkdir(join(dir, 'directory'));
  await writeFile(join(dir, 'directory/file'), 'keep owner\n');
  await git(dir, ['add', '--', 'directory']);
  await git(dir, ['commit', '-qm', 'directory before the move']);
  const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  await git(dir, ['checkout', '-qb', 'handback-move']);
  await writeFile(join(dir, 'directory/file'), 'after merge\n');
  await git(dir, ['commit', '-qam', 'rewrite file']);
  await git(dir, ['checkout', '-q', 'main']);
  await git(dir, ['merge', '--no-ff', '--no-edit', 'handback-move']);
  const owner = (await lstatNoFollow(dir, 'directory/file', { strict: true }))!.stats;
  await rename(join(dir, 'directory'), join(dir, 'retained'));
  await symlink('retained', join(dir, 'directory'));
  expect((await git(dir, ['diff', '--name-only', before])).split('\n')).toContain('directory/file');
  await expect(lstatNoFollow(dir, 'directory/file', { strict: true })).rejects.toMatchObject({
    code: 'EPATHCONTAINMENT',
  });
  vi.mocked(chownNoFollow).mockClear();
  await expect(handBackAfterMove(dir, before, true)).resolves.toBeUndefined();
  expect(chownNoFollow).not.toHaveBeenCalled();
  const retained = (await lstatNoFollow(dir, 'retained/file', { strict: true }))!.stats;
  expect([retained.uid, retained.gid]).toEqual([owner.uid, owner.gid]);
  expect(await readFile(join(dir, 'retained/file'), 'utf8')).toBe('after merge\n');
});
