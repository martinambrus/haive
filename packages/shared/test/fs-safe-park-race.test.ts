import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ beforeRename: null as null | (() => Promise<void>) }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    // Something replacing the entry between the primitive's lstat and its rename.
    rename: async (from: string, to: string) => {
      const hook = h.beforeRename;
      h.beforeRename = null;
      if (hook) await hook();
      return real.rename(from, to);
    },
  };
});

import { mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeFileIfNoFollow, rewriteFileIfNoFollow } from '../src/fs-safe.js';

describe('a directory swapped in before the file is parked', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fs-safe-park-'));
    await writeFile(path.join(root, 'a.txt'), 'hello', 'utf8');
    h.beforeRename = async () => {
      await unlink(path.join(root, 'a.txt'));
      await mkdir(path.join(root, 'a.txt'));
      await writeFile(path.join(root, 'a.txt', 'inside.txt'), 'mine', 'utf8');
    };
  });

  afterEach(async () => {
    h.beforeRename = null;
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['removeFileIfNoFollow', () => removeFileIfNoFollow(root, 'a.txt', () => true)],
    ['rewriteFileIfNoFollow', () => rewriteFileIfNoFollow(root, 'a.txt', () => Buffer.from('x'))],
  ])('%s puts it back where it was', async (_name, act) => {
    expect(await act()).toBe('kept');
    expect(h.beforeRename).toBeNull();
    expect((await stat(path.join(root, 'a.txt'))).isDirectory()).toBe(true);
    expect(await readdir(root)).toEqual(['a.txt']);
    expect(await readdir(path.join(root, 'a.txt'))).toEqual(['inside.txt']);
  });
});
