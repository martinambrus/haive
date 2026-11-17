import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ beforeRead: null as null | (() => Promise<void>) }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    readdir: async (...args: Parameters<typeof real.readdir>) => {
      const hook = hooks.beforeRead;
      hooks.beforeRead = null;
      await hook?.();
      return real.readdir(...args);
    },
  };
});
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeNoFollow } from '../src/fs-safe.js';
let root: string;
let expectedDirectory: { dev: bigint; ino: bigint };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fs-remove-identity-'));
  await mkdir(join(root, 'dir'));
  await writeFile(join(root, 'dir/keep'), 'original');
  expectedDirectory = await stat(join(root, 'dir'), { bigint: true });
});
afterEach(async () => {
  hooks.beforeRead = null;
  await rm(root, { recursive: true, force: true });
});
it('removes a matching directory through its held identity', async () => {
  expect(await removeNoFollow(root, 'dir', { recursive: true, expectedDirectory })).toBe(true);
  await expect(stat(join(root, 'dir'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses a different directory without deleting its contents', async () => {
  await rename(join(root, 'dir'), join(root, 'original'));
  await mkdir(join(root, 'dir'));
  await writeFile(join(root, 'dir/keep'), 'replacement');
  await expect(
    removeNoFollow(root, 'dir', { recursive: true, expectedDirectory }),
  ).rejects.toMatchObject({ code: 'EDIRECTORYIDENTITY' });
  expect(await readFile(join(root, 'dir/keep'), 'utf8')).toBe('replacement');
  expect(await readFile(join(root, 'original/keep'), 'utf8')).toBe('original');
});
it('refuses a symlink leaf without unlinking it or deleting its target', async () => {
  await rename(join(root, 'dir'), join(root, 'original'));
  await symlink('original', join(root, 'dir'));
  await expect(
    removeNoFollow(root, 'dir', { recursive: true, expectedDirectory }),
  ).rejects.toMatchObject({ code: 'EDIRECTORYIDENTITY' });
  expect(await readFile(join(root, 'dir/keep'), 'utf8')).toBe('original');
});
it('returns false for an already absent directory', async () => {
  await rm(join(root, 'dir'), { recursive: true });
  expect(await removeNoFollow(root, 'dir', { recursive: true, expectedDirectory })).toBe(false);
});
it.each(['directory', 'symlink'] as const)(
  'keeps a %s substituted after open, before the final rmdir',
  async (kind) => {
    hooks.beforeRead = async () => {
      await rename(join(root, 'dir'), join(root, 'original'));
      if (kind === 'directory') await mkdir(join(root, 'dir'));
      else await symlink('original', join(root, 'dir'));
    };
    await expect(
      removeNoFollow(root, 'dir', { recursive: true, expectedDirectory }),
    ).rejects.toMatchObject({ code: 'EDIRECTORYIDENTITY' });
    await expect(
      (await import('node:fs/promises')).lstat(join(root, 'dir')),
    ).resolves.toBeDefined();
  },
);
