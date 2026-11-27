import {
  mkdtemp,
  mkdir,
  writeFile,
  link,
  readFile,
  lstat,
  rm,
  rename,
  symlink,
  open,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsSafe from '@haive/shared/fs-safe';
import { sweepWorktreeAliases, WORKTREE_ALIAS_LIMITS } from '../src/repo/worktree-alias-sweep.js';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worktree-alias-'));
  roots.push(root);
  await mkdir(path.join(root, '.haive/worktrees/task'), { recursive: true });
  return root;
}
async function drain(root: string, opts = {}) {
  const result = [];
  for await (const progress of sweepWorktreeAliases(root, opts)) result.push(progress);
  return result;
}
describe('one-time legacy worktree alias sweep', () => {
  it('breaks every externally linked name, retains internal-only aliases and leaves outside bytes alone', async () => {
    expect(WORKTREE_ALIAS_LIMITS).toEqual({
      maxDirectoryEntries: 10_000,
      maxLinkedNames: 200_000,
      maxEntries: 2_000_000,
      maxDepth: 128,
      maxPasses: 4,
    });
    const root = await fixture();
    const tree = path.join(root, '.haive/worktrees/task');
    await writeFile(path.join(root, 'outside'), 'original');
    await link(path.join(root, 'outside'), path.join(tree, 'one'));
    await link(path.join(root, 'outside'), path.join(tree, 'two'));
    await writeFile(path.join(tree, 'internal'), 'internal');
    await link(path.join(tree, 'internal'), path.join(tree, 'internal-two'));
    const internal = await lstat(path.join(tree, 'internal'), { bigint: true });
    await drain(root);
    expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
    expect((await lstat(path.join(tree, 'internal'), { bigint: true })).ino).toBe(internal.ino);
    await writeFile(path.join(root, 'outside'), 'changed');
    expect(await readFile(path.join(tree, 'one'), 'utf8')).toBe('original');
    expect(await readFile(path.join(tree, 'two'), 'utf8')).toBe('original');
    const first = await lstat(path.join(tree, 'one'), { bigint: true });
    await drain(root);
    expect((await lstat(path.join(tree, 'one'), { bigint: true })).ino).toBe(first.ino);
  });
  it('resumes after interruption by rescanning, never follows links, and enforces small injectable bounds', async () => {
    const root = await fixture();
    const tree = path.join(root, '.haive/worktrees/task');
    await writeFile(path.join(root, 'outside'), 'original');
    await link(path.join(root, 'outside'), path.join(tree, 'one'));
    await link(path.join(root, 'outside'), path.join(tree, 'two'));
    await symlink(root, path.join(tree, 'loop'));
    expect((await drain(root, { maxLinkedNames: 1 })).at(-1)).toMatchObject({
      skipped: { linked_name_limit: expect.any(Number) },
    });
    await link(path.join(root, 'outside'), path.join(tree, 'three'));
    await link(path.join(root, 'outside'), path.join(tree, 'four'));
    const interrupted = sweepWorktreeAliases(root);
    for await (const progress of interrupted) {
      if (progress.replaced === 1) break;
    }
    expect((await lstat(path.join(root, 'outside'))).nlink).toBe(2);
    await drain(root);
    expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
    expect((await drain(root, { maxDirectoryEntries: 1 })).at(-1)).toMatchObject({
      skipped: { oversized_directory: expect.any(Number) },
    });
    await rm(path.join(root, '.haive'), { recursive: true });
    await symlink(root, path.join(root, '.haive'));
    await expect(drain(root)).rejects.toMatchObject({ code: 'EPATHCONTAINMENT' });
  });
});

it('resumes discovery from a durable cursor, including a directory prefix beside a hyphenated sibling', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await mkdir(path.join(tree, 'a'));
  await writeFile(path.join(root, 'outside'), 'original');
  await link(path.join(root, 'outside'), path.join(tree, 'a/file'));
  await link(path.join(root, 'outside'), path.join(tree, 'a-file'));
  const names = [];
  let scan;
  for await (const progress of sweepWorktreeAliases(root)) {
    if (progress.discovered) names.push(progress.discovered);
    scan = progress.scan;
    if (scan?.cursor.endsWith('/a/file')) break;
  }
  expect(scan?.examined).toBe(3);
  const resumed = await drain(root, { resume: { scan: scan!, names } });
  expect(resumed.filter((p) => p.discovered).map((p) => p.discovered?.path)).toEqual([
    '.haive/worktrees/task/a-file',
  ]);
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
});

it('counts a discovered name that moves before copying', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await writeFile(path.join(root, 'outside'), 'original');
  await link(path.join(root, 'outside'), path.join(tree, 'source'));
  const walk = sweepWorktreeAliases(root);
  for (;;) {
    const next = await walk.next();
    if (next.done || next.value.scan?.complete) break;
  }
  await rename(path.join(tree, 'source'), path.join(tree, 'renamed'));
  for await (const ignored of walk) void ignored;
  await drain(root);
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
});

it('counts a discovered directory that vanishes before its listing', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await writeFile(path.join(root, 'outside'), 'original');
  await link(path.join(root, 'outside'), path.join(tree, 'source'));
  const walk = sweepWorktreeAliases(root);
  expect((await walk.next()).value).toMatchObject({ scan: { cursor: '.haive/worktrees/task' } });
  await rename(tree, `${tree}-moved`);
  for await (const ignored of walk) void ignored;
  await drain(root);
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
});

it('counts undecodable filenames without hiding a healthy sibling', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await writeFile(path.join(root, 'outside'), 'original');
  const raw = Buffer.concat([Buffer.from(`${tree}/`), Buffer.from([0xff])]);
  await link(path.join(root, 'outside'), raw);
  await writeFile(path.join(tree, '\ufffd'), 'valid sibling');
  expect((await drain(root)).at(-1)).toMatchObject({
    skipped: { non_utf8_name: expect.any(Number) },
  });
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(2);
  expect(await readFile(path.join(tree, '\ufffd'), 'utf8')).toBe('valid sibling');
  await rm(raw);
  await rm(path.join(tree, '\ufffd'));
  await link(path.join(root, 'outside'), path.join(tree, '\ufffd'));
  await drain(root);
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
  expect(await readFile(path.join(tree, '\ufffd'), 'utf8')).toBe('original');
});

it('M4 detaches links shared between different task worktrees', async () => {
  const root = await fixture();
  const first = path.join(root, '.haive/worktrees/task/f');
  const second = path.join(root, '.haive/worktrees/other/f');
  await mkdir(path.dirname(second));
  await writeFile(first, 'before');
  await link(first, second);
  await drain(root);
  await writeFile(first, 'after');
  expect(await readFile(second, 'utf8')).toBe('before');
});
it('M2 skips an oversized aliased file and continues with its healthy sibling', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await writeFile(path.join(root, 'big'), 'oversized');
  await link(path.join(root, 'big'), path.join(tree, 'a-big'));
  await writeFile(path.join(root, 'small'), 'ok');
  await link(path.join(root, 'small'), path.join(tree, 'z-small'));
  const progress = await drain(root, { maxBytes: 3 });
  expect((await lstat(path.join(root, 'small'))).nlink).toBe(1);
  expect(progress.at(-1)).toMatchObject({ skipped: { oversized_file: expect.any(Number) } });
});
it('M2 repeats discovery after detaching to catch an alias moved behind the cursor', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await mkdir(path.join(tree, 'a'));
  await mkdir(path.join(tree, 'z'));
  await writeFile(path.join(root, 'outside'), 'bytes');
  await link(path.join(root, 'outside'), path.join(tree, 'middle'));
  await link(path.join(root, 'outside'), path.join(tree, 'z/hidden'));
  const walk = sweepWorktreeAliases(root);
  let moved = false;
  for await (const p of walk) {
    if (!moved && p.scan?.cursor.endsWith('/middle')) {
      moved = true;
      await rename(path.join(tree, 'z/hidden'), path.join(tree, 'a/hidden'));
    }
  }
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
});
it('M6 skips a vanished entry without abandoning healthy discoveries', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await writeFile(path.join(root, 'outside'), 'bytes');
  await link(path.join(root, 'outside'), path.join(tree, 'a'));
  await writeFile(path.join(tree, 'z'), 'temporary');
  for await (const p of sweepWorktreeAliases(root)) {
    if (p.discovered?.path.endsWith('/a')) await rm(path.join(tree, 'z'), { force: true });
  }
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
});
it('L2 removes abandoned private copy temps without staging them as ordinary aliases', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  const temp = path.join(tree, '.file.haive-tmp-123-11111111-1111-1111-1111-111111111111');
  await writeFile(temp, 'partial private copy');
  await drain(root, { staleTempMs: 0 });
  await expect(lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('M2 isolates a raw non-UTF8 name, a foreign park directory and an oversized directory', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await writeFile(path.join(root, 'outside'), 'bytes');
  await link(path.join(root, 'outside'), path.join(tree, 'healthy'));
  await writeFile(Buffer.concat([Buffer.from(`${tree}/`), Buffer.from([0xff])]), 'bad name');
  await mkdir(path.join(tree, '.fake.haive-alias-park-123-11111111-1111-1111-1111-111111111111'));
  await mkdir(path.join(tree, 'large'));
  for (let i = 0; i < 5; i++) await writeFile(path.join(tree, 'large', String(i)), 'file');
  const progress = await drain(root, { maxDirectoryEntries: 4 });
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
  expect(progress.at(-1)).toMatchObject({
    skipped: {
      non_utf8_name: expect.any(Number),
      foreign_park: expect.any(Number),
      oversized_directory: expect.any(Number),
    },
  });
});
it('M2 bounds repeated passes and records the pass cap when aliases keep arriving', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await writeFile(path.join(root, 'outside'), 'bytes');
  await link(path.join(root, 'outside'), path.join(tree, 'initial'));
  let injected = 0;
  let last;
  for await (const p of sweepWorktreeAliases(root, { maxPasses: 2 })) {
    if (p.scan?.complete && p.scan.pass! > injected) {
      injected = p.scan.pass!;
      await link(path.join(root, 'outside'), path.join(tree, `later-${injected}`));
    }
    last = p;
  }
  expect(last).toMatchObject({ scan: { pass: 2 }, skipped: { pass_limit: 1 } });
});
it('L9 refuses an absent repository anchor rather than stamping an empty tree', async () => {
  const root = await fixture();
  await rm(root, { recursive: true });
  await expect(drain(root)).rejects.toThrow('Repository anchor is unavailable');
});
it('M2 counts foreign park-like names that do not match any recovery namespace', async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, '.haive/worktrees/task/.file.haive-alias-park-foreign'),
    'foreign',
  );
  expect((await drain(root)).at(-1)).toMatchObject({ skipped: { foreign_park: 1 } });
});

// Exercise actual FileHandle operations: these errors must reach the repository backoff.
it.each(['write', 'read', 'readdir'] as const)(
  'M-A propagates a systemic %s failure and never certifies completion',
  async (operation) => {
    const root = await fixture();
    await writeFile(path.join(root, 'outside'), 'original');
    await link(path.join(root, 'outside'), path.join(root, '.haive/worktrees/task/f'));
    const sample = await open(path.join(root, 'outside'));
    const proto = Object.getPrototypeOf(sample);
    await sample.close();
    const code = operation === 'write' ? 'ENOSPC' : 'EIO';
    if (operation === 'readdir')
      vi.spyOn(fsSafe, 'readdirNoFollow').mockRejectedValue(
        Object.assign(new Error('injected'), { code }),
      );
    else
      vi.spyOn(proto, operation).mockRejectedValue(Object.assign(new Error('injected'), { code }));
    await expect(drain(root)).rejects.toMatchObject({ code });
    const { WorktreeAliasSweeper } = await import('../src/repo/worktree-alias-background.js');
    const complete = vi.fn();
    const fail = vi.fn(async () => undefined);
    const checkpoint = vi.fn(async () => undefined);
    const worker = new WorktreeAliasSweeper({
      next: async () => ({ id: 'r', anchor: root }),
      complete,
      fail,
      checkpoint,
    });
    await worker.tick();
    await worker.stop();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ attempts: 1 }));
    if (operation !== 'readdir') expect(checkpoint).toHaveBeenCalled();
    expect((await lstat(path.join(root, 'outside'))).nlink).toBe(2);
  },
);
it('L-f preserves internal pairs beside mixed links spanning three worktrees, the root and checkout', async () => {
  const root = await fixture();
  const base = path.join(root, '.haive/worktrees');
  for (const name of ['b', 'c']) await mkdir(path.join(base, name));
  await writeFile(path.join(root, 'outside'), 'shared');
  const shared = ['task/a1', 'task/a2', 'b/b1', 'c/c1', 'root-file'];
  for (const name of shared) await link(path.join(root, 'outside'), path.join(base, name));
  await writeFile(path.join(base, 'task/internal1'), 'internal');
  await link(path.join(base, 'task/internal1'), path.join(base, 'task/internal2'));
  const internal = await lstat(path.join(base, 'task/internal1'), { bigint: true });
  // A second group has only cross-task aliases, with two names in its first owner.
  await writeFile(path.join(base, 'task/cross1'), 'cross');
  for (const name of ['task/cross2', 'b/cross', 'c/cross'])
    await link(path.join(base, 'task/cross1'), path.join(base, name));
  await drain(root);
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
  for (const name of shared) {
    expect((await lstat(path.join(base, name))).nlink).toBe(1);
    expect(await readFile(path.join(base, name), 'utf8')).toBe('shared');
  }
  await writeFile(path.join(base, 'task/cross1'), 'changed');
  for (const name of ['b/cross', 'c/cross'])
    expect(await readFile(path.join(base, name), 'utf8')).toBe('cross');
  expect((await lstat(path.join(base, 'task/internal2'), { bigint: true })).ino).toBe(internal.ino);
  expect((await lstat(path.join(base, 'task/internal1'))).nlink).toBe(2);
});

it('spreads artifact recovery across ticks and permits shutdown between entries', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  for (let i = 0; i < 7; i++)
    await writeFile(
      path.join(tree, `.f${i}.haive-alias-tmp-123-11111111-1111-1111-1111-111111111111`),
      'partial',
    );
  await writeFile(path.join(root, 'outside'), 'original');
  await link(path.join(root, 'outside'), path.join(tree, 'healthy'));
  const { WorktreeAliasSweeper } = await import('../src/repo/worktree-alias-background.js');
  const complete = vi.fn(async () => true);
  const store = { next: async () => ({ id: 'r', anchor: root }), complete };
  const worker = new WorktreeAliasSweeper(store, { maxSteps: 1 });
  await worker.tick(); // Discover the task directory.
  await worker.tick(); // Recover at most one artifact.
  expect((await readdir(tree)).filter((name) => name.includes('haive-alias-tmp'))).toHaveLength(6);
  await worker.stop();
  expect(complete).not.toHaveBeenCalled();
  // Restarted discovery completes the same cleanup and still detaches healthy aliases.
  const restarted = new WorktreeAliasSweeper(store, { maxSteps: 1 });
  for (let tick = 0; tick < 80 && !complete.mock.calls.length; tick++) await restarted.tick();
  expect(complete).toHaveBeenCalledOnce();
  await restarted.stop();
  expect(await readdir(tree)).toEqual(['healthy']);
  expect(await readFile(path.join(tree, 'healthy'), 'utf8')).toBe('original');
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
});
