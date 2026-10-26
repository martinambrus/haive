import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({
  rmdir: null as null | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
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
describe('atomic empty-directory recovery', () => {
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
  it('keeps a different identity already installed before the attempt', async () => {
    const id = await identity();
    await real.rename(join(root, 'dir'), join(root, 'saved'));
    await mkdir(join(root, 'dir'));
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('kept');
    expect((await stat(join(root, 'dir'))).ino).not.toBe(Number(id.ino));
    expect((await stat(join(root, 'saved'))).ino).toBe(Number(id.ino));
    expect((await readdir(root)).sort()).toEqual(['dir', 'saved']);
  });
  it('keeps a leaf link racing at the rmdir syscall without following it', async () => {
    const id = await identity();
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside/foreign'), 'person');
    hooks.rmdir = async () => {
      await real.rename(join(root, 'dir'), join(root, 'saved'));
      await symlink(join(root, 'outside'), join(root, 'dir'));
    };
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('kept');
    expect(await readFile(join(root, 'outside/foreign'), 'utf8')).toBe('person');
    expect((await readdir(root)).sort()).toEqual(['dir', 'outside', 'saved']);
  });
  it('keeps a foreign child arriving at the atomic empty check', async () => {
    const id = await identity();
    hooks.rmdir = async (path) => {
      await writeFile(`${path}/foreign`, 'late person');
    };
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('kept');
    expect(await readFile(join(root, 'dir/foreign'), 'utf8')).toBe('late person');
    expect((await stat(join(root, 'dir'))).ino).toBe(Number(id.ino));
    expect(await readdir(root)).toEqual(['dir']);
  });
  it('allows a same-value empty replacement racing after the identity check', async () => {
    const id = await identity();
    hooks.rmdir = async () => {
      await real.rename(join(root, 'dir'), join(root, 'saved'));
      await mkdir(join(root, 'dir'));
    };
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('removed');
    expect((await stat(join(root, 'saved'))).ino).toBe(Number(id.ino));
    expect(await readdir(root)).toEqual(['saved']);
  });
  it('keeps a regular file replacing the directory at the syscall', async () => {
    const id = await identity();
    hooks.rmdir = async () => {
      await real.rename(join(root, 'dir'), join(root, 'saved'));
      await writeFile(join(root, 'dir'), 'person');
    };
    expect(await removeEmptyDirectoryIfNoFollow(root, 'dir', id)).toBe('kept');
    expect(await readFile(join(root, 'dir'), 'utf8')).toBe('person');
    expect((await stat(join(root, 'saved'))).ino).toBe(Number(id.ino));
  });
  it('retains the original rmdir error when another entry takes the original name', async () => {
    const id = await identity();
    const primary = Object.assign(new Error('primary directory EIO'), { code: 'EIO' });
    hooks.rmdir = async () => {
      if (await real.lstat(join(root, 'dir')).catch(() => null))
        await real.rename(join(root, 'dir'), join(root, 'saved'));
      await writeFile(join(root, 'dir'), 'person replacement');
      throw primary;
    };
    const failure = await removeEmptyDirectoryIfNoFollow(root, 'dir', id).catch(
      (err: unknown) => err,
    );
    expect(failure).toBe(primary);
    expect(await readFile(join(root, 'dir'), 'utf8')).toBe('person replacement');
    expect((await readdir(root)).some((name) => name.includes('.haive-park-'))).toBe(false);
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
