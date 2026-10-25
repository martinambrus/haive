import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({
  rename: null as null | (() => Promise<void>),
  rmdir: null as null | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      const hook = hooks.rename;
      hooks.rename = null;
      await hook?.();
      return real.rename(from, to);
    },
    rmdir: async (path: string) => {
      const hook = hooks.rmdir;
      hooks.rmdir = null;
      await hook?.(path);
      return real.rmdir(path);
    },
  };
});
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileIdentity, openDirNoFollow, removeEmptyDirectoryIfNoFollow } from '../src/fs-safe.js';
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fs-empty-directory-'));
  await mkdir(join(root, 'dir'));
});
afterEach(async () => {
  hooks.rename = null;
  hooks.rmdir = null;
  await rm(root, { recursive: true, force: true });
});
const identity = async () => {
  const fh = await openDirNoFollow(root, 'dir');
  try {
    return await fileIdentity(fh);
  } finally {
    await fh.close();
  }
};
describe('empty-directory identity removal', () => {
  it('removes an empty held identity and repeats absence', async () => {
    const id = await identity();
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('removed');
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('absent');
    expect(await readdir(root)).toEqual([]);
  });
  it('keeps nonempty directories and their metadata', async () => {
    const id = await identity();
    const before = await stat(join(root, 'dir'));
    await writeFile(join(root, 'dir/foreign'), 'person');
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('kept');
    expect(await readFile(join(root, 'dir/foreign'), 'utf8')).toBe('person');
    expect((await stat(join(root, 'dir'))).ino).toBe(before.ino);
  });
  it('refuses a different empty directory installed before parking', async () => {
    const id = await identity();
    hooks.rename = async () => {
      await real.rename(join(root, 'dir'), join(root, 'saved'));
      await mkdir(join(root, 'dir'));
    };
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('kept');
    expect((await stat(join(root, 'dir'))).ino).not.toBe(Number(id.ino));
    expect((await stat(join(root, 'saved'))).ino).toBe(Number(id.ino));
    expect((await readdir(root)).sort()).toEqual(['dir', 'saved']);
  });
  it('keeps a leaf link swapped in before parking without following it', async () => {
    const id = await identity();
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside/foreign'), 'person');
    hooks.rename = async () => {
      await real.rename(join(root, 'dir'), join(root, 'saved'));
      await symlink(join(root, 'outside'), join(root, 'dir'));
    };
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('kept');
    expect(await readFile(join(root, 'outside/foreign'), 'utf8')).toBe('person');
    expect((await readdir(root)).sort()).toEqual(['dir', 'outside', 'saved']);
  });
  it('puts the directory back if a foreign child arrives after the empty check', async () => {
    const id = await identity();
    hooks.rmdir = async (path) => {
      await writeFile(`${path}/foreign`, 'late person');
    };
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('kept');
    expect(await readFile(join(root, 'dir/foreign'), 'utf8')).toBe('late person');
    expect((await stat(join(root, 'dir'))).ino).toBe(Number(id.ino));
    expect(await readdir(root)).toEqual(['dir']);
  });
  it('refuses a linked ancestor', async () => {
    await mkdir(join(root, 'parent'));
    await rename(join(root, 'dir'), join(root, 'parent/dir'));
    const fh = await openDirNoFollow(root, 'parent/dir');
    const id = await fileIdentity(fh);
    await fh.close();
    await symlink(join(root, 'parent'), join(root, 'linked'));
    await expect(removeEmptyDirectoryIfNoFollow(root, 'linked/dir', id)).rejects.toThrow();
    expect((await stat(join(root, 'parent/dir'))).ino).toBe(Number(id.ino));
  });
});
