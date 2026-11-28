import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chownNoFollow, lstatNoFollow } from '@haive/shared/fs-safe';
import { gitTemplate } from './support/git-template.js';
import { git } from './support/projection-fixture.js';
import {
  captureFixBaseline,
  handBackAfterMove,
  relocateFixerChanges,
} from '../src/step-engine/git-merge.js';

const fault = vi.hoisted(() => ({
  rel: '',
  code: '',
  fake: false,
  deleted: false,
  run: vi.fn<typeof import('../src/repo/git-exec.js').gitRun>(),
  stat: vi.fn(),
  read: vi.fn(async () => []),
  write: vi.fn(async () => {}),
  files: new Map<string, string>(),
  move: vi.fn(),
}));
vi.mock('../src/repo/git-exec.js', async (original) => {
  const real = await original<typeof import('../src/repo/git-exec.js')>();
  return {
    ...real,
    gitRun: (...args: Parameters<typeof real.gitRun>) =>
      fault.fake ? fault.run(...args) : real.gitRun(...args),
  };
});
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
      if (fault.fake) return fault.stat(...args);
      const entry = await real.lstatNoFollow(...args);
      return entry && args[1] === 'conflict'
        ? { ...entry, stats: { ...entry.stats, uid: 0 } }
        : entry;
    },
    readdirNoFollow: (...args: Parameters<typeof real.readdirNoFollow>) =>
      fault.fake ? fault.read() : real.readdirNoFollow(...args),
    // No unit variant may fall through to a filesystem mutation, including on the red source.
    writeFileNoFollow: (...args: Parameters<typeof real.writeFileNoFollow>) =>
      fault.fake ? fault.write() : real.writeFileNoFollow(...args),
    renameNoFollow: (...args: Parameters<typeof real.renameNoFollow>) =>
      fault.fake ? fault.move(...args) : real.renameNoFollow(...args),
    removeNoFollow: (...args: Parameters<typeof real.removeNoFollow>) =>
      fault.fake ? Promise.resolve(false) : real.removeNoFollow(...args),
    chmodNoFollow: (...args: Parameters<typeof real.chmodNoFollow>) =>
      fault.fake ? Promise.resolve() : real.chmodNoFollow(...args),
    chownNoFollow: vi.fn(async () => {}),
  };
});
afterEach(() => {
  fault.code = '';
  fault.fake = false;
  fault.deleted = false;
  fault.run.mockReset();
  fault.stat.mockReset();
  fault.read.mockClear();
  fault.write.mockClear();
  fault.move.mockReset();
  fault.files.clear();
  vi.mocked(chownNoFollow).mockClear();
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

it('real Git changed paths are handed back after an unreadable path is retried', async () => {
  const { dir, data: before } = await template.copy();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  fault.rel = 'conflict';
  fault.code = 'EACCES';
  await expect(handBackAfterMove(dir, before, true)).rejects.toMatchObject({
    code: 'MERGE_HAND_BACK_FAILED',
  });
  fault.code = '';
  await expect(handBackAfterMove(dir, before, true)).resolves.toBeUndefined();
  expect(chownNoFollow).toHaveBeenCalledWith(dir, 'conflict', expect.any(Object));
});

it('real Git fixer changes stay intact until the merge owner can be read', async () => {
  const { dir } = await template.copy();
  await git(dir, ['merge', '--no-ff', '--no-edit', 'feature']).catch(() => {});
  const baseline = await captureFixBaseline(dir, async () => null);
  expect(baseline).toHaveProperty('tree');
  await writeFile(join(dir, 'outside'), 'fixer edit\n');
  const index = await git(dir, ['ls-files', '-s', '-z']);
  fault.rel = '';
  fault.code = 'EACCES';
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
});

// Errno decisions fake both Git and filesystem seams, without copying a repository.
describe('hand-back decisions with fake I/O', () => {
  const dir = '/fake/hand-back';
  const baseline = {
    tree: 'tree',
    index: 'index',
    ignored: 'ignored',
    resolving: ['conflict'],
    head: 'head',
    mergeHead: 'merge-head',
  };

  function fakeIo() {
    fault.fake = true;
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    fault.files.set('outside', 'fixer edit\n');
    fault.move.mockImplementation(async (_anchor, from, to) => {
      fault.files.set(to, fault.files.get(from)!);
      fault.files.delete(from);
    });
    fault.stat.mockImplementation(async (_anchor, rel) =>
      (fault.deleted && rel === 'conflict') || (rel === 'outside' && !fault.files.has(rel))
        ? null
        : { kind: rel === '' ? 'directory' : 'file', stats: { uid: 0, gid: 0, mode: 0o100644 } },
    );
    fault.run.mockImplementation(async (_dir, args) => {
      if (args[0] === 'diff' && args.includes('--name-only'))
        return { code: 0, stdout: 'conflict\0', stderr: '' };
      if (args[0] === 'rev-parse')
        return { code: 0, stdout: args.at(-1) === 'HEAD' ? 'head' : 'merge-head', stderr: '' };
      if (args[0] === 'update-index' && args.includes('--refresh'))
        return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'hash-object') return { code: 0, stdout: 'empty-tree', stderr: '' };
      if (args[0] === 'write-tree') return { code: 0, stdout: 'after-tree', stderr: '' };
      if (args[0] === 'diff-tree')
        return { code: 0, stdout: ':100644 100644 old new M\0outside\0', stderr: '' };
      if (args.includes('restore') && args.includes('--worktree')) {
        fault.files.set('outside', 'original\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (
        ['cat-file', 'read-tree', 'ls-files', 'diff-index'].includes(args[0]!) ||
        args.includes('add')
      )
        return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected fake Git command: ${args.join(' ')}`);
    });
  }

  it.each(['EACCES', 'EMFILE'])(
    'strict hand-back refuses an unknown path (%s), and retry succeeds',
    async (code) => {
      fakeIo();
      fault.rel = 'conflict';
      fault.code = code;
      await expect(handBackAfterMove(dir, 'before', true)).rejects.toMatchObject({
        code: 'MERGE_HAND_BACK_FAILED',
      });
      expect(chownNoFollow).not.toHaveBeenCalled();
      fault.code = '';
      await expect(handBackAfterMove(dir, 'before', true)).resolves.toBeUndefined();
      expect(chownNoFollow).toHaveBeenCalledWith(dir, 'conflict', expect.any(Object));
      expect(fault.run.mock.calls.map(([, args]) => args)).toContainEqual([
        'update-index',
        '-q',
        '--refresh',
      ]);
    },
  );

  it.each(['EACCES', 'EMFILE'])(
    'fixer relocation refuses an unreadable owner (%s) before moving or restoring bytes',
    async (code) => {
      fakeIo();
      fault.rel = '';
      fault.code = code;
      await expect(
        relocateFixerChanges(dir, baseline, { taskId: 'task', runId: 'run' }, async () => null),
      ).rejects.toMatchObject({ code: 'MERGE_OWNER_UNREADABLE' });
      expect(fault.run.mock.calls.map(([, args]) => args)).toEqual([
        ['rev-parse', '-q', '--verify', 'HEAD'],
        ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
      ]);
      expect(fault.write).not.toHaveBeenCalled();
      expect(chownNoFollow).not.toHaveBeenCalled();
      expect(fault.move).not.toHaveBeenCalled();
      expect(fault.files.get('outside')).toBe('fixer edit\n');
      fault.code = '';
      const result = await relocateFixerChanges(
        dir,
        baseline,
        { taskId: 'task', runId: 'run' },
        async () => null,
      );
      expect(result?.moved).toContain('outside');
      expect(fault.files.get('outside')).toBe('original\n');
      expect(fault.files.get(`${result?.folder}/files/outside`)).toBe('fixer edit\n');
    },
  );

  it('a positively deleted path needs no hand-back', async () => {
    fakeIo();
    fault.deleted = true;
    await expect(handBackAfterMove(dir, 'before', true)).resolves.toBeUndefined();
    expect(chownNoFollow).not.toHaveBeenCalled();
  });
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
