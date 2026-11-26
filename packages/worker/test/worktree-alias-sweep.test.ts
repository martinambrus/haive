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
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepWorktreeAliases, WORKTREE_ALIAS_LIMITS } from '../src/repo/worktree-alias-sweep.js';
const roots: string[] = [];
afterEach(async () => {
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
    await expect(drain(root, { maxLinkedNames: 1 })).rejects.toThrow(/limit/);
    const interrupted = sweepWorktreeAliases(root);
    for await (const progress of interrupted) {
      if (progress.replaced === 1) break;
    }
    expect((await lstat(path.join(root, 'outside'))).nlink).toBe(2);
    await drain(root);
    expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
    await expect(drain(root, { maxDirectoryEntries: 1 })).rejects.toThrow(/limit/);
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

it('refuses completion when a discovered name moves before copying', async () => {
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
  await expect(walk.next()).rejects.toThrow(/rescan/);
  await drain(root);
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
});

it('refuses completion when a discovered directory moves before its listing', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await writeFile(path.join(root, 'outside'), 'original');
  await link(path.join(root, 'outside'), path.join(tree, 'source'));
  const walk = sweepWorktreeAliases(root);
  expect((await walk.next()).value).toMatchObject({ scan: { cursor: '.haive/worktrees/task' } });
  await rename(tree, `${tree}-moved`);
  await expect(walk.next()).rejects.toThrow(/rescan/);
  await drain(root);
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
});

it('refuses undecodable filenames even beside a real replacement-character name', async () => {
  const root = await fixture();
  const tree = path.join(root, '.haive/worktrees/task');
  await writeFile(path.join(root, 'outside'), 'original');
  const raw = Buffer.concat([Buffer.from(`${tree}/`), Buffer.from([0xff])]);
  await link(path.join(root, 'outside'), raw);
  await writeFile(path.join(tree, '\ufffd'), 'valid sibling');
  await expect(drain(root)).rejects.toMatchObject({ code: 'ENOTUTF8' });
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(2);
  expect(await readFile(path.join(tree, '\ufffd'), 'utf8')).toBe('valid sibling');
  await rm(raw);
  await rm(path.join(tree, '\ufffd'));
  await link(path.join(root, 'outside'), path.join(tree, '\ufffd'));
  await drain(root);
  expect((await lstat(path.join(root, 'outside'))).nlink).toBe(1);
  expect(await readFile(path.join(tree, '\ufffd'), 'utf8')).toBe('original');
});
