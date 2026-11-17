import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({
  beforeRead: null as null | (() => Promise<void>),
  afterLstat: null as null | (() => Promise<void>),
  identity: null as bigint | null,
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      const st = await real.lstat(...args);
      if (String(args[0]).endsWith('/dir') && hooks.identity !== null)
        Object.assign(st, {
          ino: typeof st.ino === 'bigint' ? hooks.identity : Number(hooks.identity),
        });
      if (String(args[0]).endsWith('/child')) {
        const hook = hooks.afterLstat;
        hooks.afterLstat = null;
        await hook?.();
      }
      return st;
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      if (String(args[0]).endsWith('/dir')) {
        const stat = fh.stat.bind(fh);
        fh.stat = (async (...opts: Parameters<typeof fh.stat>) => {
          const st = await stat(...opts);
          if (hooks.identity !== null)
            Object.assign(st, {
              ino: typeof st.ino === 'bigint' ? hooks.identity : Number(hooks.identity),
            });
          return st;
        }) as typeof fh.stat;
      }
      return fh;
    },
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
import { lstatNoFollow, removeNoFollow } from '../src/fs-safe.js';
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
  hooks.afterLstat = null;
  hooks.identity = null;
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
      if (kind === 'directory') {
        await mkdir(join(root, 'dir'));
        await writeFile(join(root, 'dir/keep'), 'replacement');
      } else {
        await mkdir(join(root, 'canary'));
        await writeFile(join(root, 'canary/keep'), 'canary');
        await symlink('canary', join(root, 'dir'));
      }
    };
    await expect(
      removeNoFollow(root, 'dir', { recursive: true, expectedDirectory }),
    ).rejects.toMatchObject({ code: 'EDIRECTORYIDENTITY' });
    await expect(
      (await import('node:fs/promises')).lstat(join(root, 'dir')),
    ).resolves.toBeDefined();
    expect(await readFile(join(root, 'dir/keep'), 'utf8')).toBe(
      kind === 'directory' ? 'replacement' : 'canary',
    );
  },
);

it('unlinks a subdirectory swapped for an outside symlink after lstat during the walk', async () => {
  await mkdir(join(root, 'dir/child'));
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside/keep'), 'outside canary');
  hooks.afterLstat = async () => {
    await rename(join(root, 'dir/child'), join(root, 'saved-child'));
    await symlink(join(root, 'outside'), join(root, 'dir/child'));
  };
  expect(await removeNoFollow(root, 'dir', { recursive: true, expectedDirectory })).toBe(true);
  expect(await readFile(join(root, 'outside/keep'), 'utf8')).toBe('outside canary');
});
it.each([0n, -1n])('compares an inode above 2^53 exactly (offset %s)', async (offset) => {
  hooks.identity = 2n ** 53n + 1n;
  const info = await lstatNoFollow(root, 'dir', { strict: true, bigint: true });
  expect(info?.stats.ino).toBe(hooks.identity);
  const expected = { dev: expectedDirectory.dev, ino: hooks.identity + offset };
  if (offset === 0n) {
    expect(
      await removeNoFollow(root, 'dir', { recursive: true, expectedDirectory: expected }),
    ).toBe(true);
  } else {
    await expect(
      removeNoFollow(root, 'dir', { recursive: true, expectedDirectory: expected }),
    ).rejects.toMatchObject({ code: 'EDIRECTORYIDENTITY' });
    expect(await readFile(join(root, 'dir/keep'), 'utf8')).toBe('original');
  }
});
