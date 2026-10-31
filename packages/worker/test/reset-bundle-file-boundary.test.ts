import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeRenderedBundleFile } from '../scripts/reset-bundle-to-commit.js';
let root: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reset-bundle-root-'));
  outside = await mkdtemp(path.join(tmpdir(), 'reset-bundle-outside-'));
  await writeFile(path.join(outside, 'keep'), 'outside bytes');
  await writeFile(path.join(root, 'unrelated'), 'user bytes');
});
afterEach(async () => {
  await Promise.all([root, outside].map((d) => rm(d, { recursive: true, force: true })));
});
it.each(['parent', 'leaf', 'escape'] as const)(
  'refuses %s without touching outside bytes or unrelated files',
  async (kind) => {
    let rel = 'nested/keep';
    if (kind === 'parent') await symlink(outside, path.join(root, 'nested'));
    else if (kind === 'escape') rel = `../${path.basename(outside)}/keep`;
    else {
      await mkdir(path.join(root, 'nested'));
      await symlink(path.join(outside, 'keep'), path.join(root, rel));
    }
    const before = await lstat(path.join(outside, 'keep'));
    await expect(writeRenderedBundleFile(root, rel, 'replacement')).rejects.toThrow();
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('outside bytes');
    expect((await lstat(path.join(outside, 'keep'))).ino).toBe(before.ino);
    expect(await readdir(outside)).toEqual(['keep']);
    expect(await readFile(path.join(root, 'unrelated'), 'utf8')).toBe('user bytes');
  },
);
it('writes and replaces only the intended artifact under the repository root', async () => {
  await writeRenderedBundleFile(root, '.claude/agents/agent.md', 'old');
  await writeRenderedBundleFile(root, '.claude/agents/agent.md', 'new');
  expect(await readFile(path.join(root, '.claude/agents/agent.md'), 'utf8')).toBe('new');
  expect(await readFile(path.join(root, 'unrelated'), 'utf8')).toBe('user bytes');
});

it('replaces an artifact hardlink without rewriting the other inode name', async () => {
  await link(path.join(outside, 'keep'), path.join(root, 'artifact'));
  const before = await lstat(path.join(outside, 'keep'));
  await writeRenderedBundleFile(root, 'artifact', 'new artifact');
  expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('outside bytes');
  expect((await lstat(path.join(outside, 'keep'))).ino).toBe(before.ino);
  expect((await lstat(path.join(root, 'artifact'))).ino).not.toBe(before.ino);
  expect(await readFile(path.join(root, 'artifact'), 'utf8')).toBe('new artifact');
});

it.each(['.git/hooks/pre-commit', 'sub/.GIT/config', '.git./config'])(
  'refuses %s, which names git data, and creates neither a file nor a directory',
  async (rel) => {
    await expect(writeRenderedBundleFile(root, rel, 'x')).rejects.toThrow();
    expect(await readdir(root)).toEqual(['unrelated']);
  },
);
