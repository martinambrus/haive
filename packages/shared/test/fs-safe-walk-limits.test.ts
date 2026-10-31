import { execFile } from 'node:child_process';
import { readdirSync, renameSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Call = 'open' | 'readdir' | 'lstat';
const h = vi.hoisted(() => ({
  /** An error to throw instead of the `nth` (1-based, per call kind) call whose first argument is `target`. */
  fault: null as null | ((call: string, target: string, nth: number) => Error | undefined),
  calls: { open: 0, readdir: 0, lstat: 0, readlink: 0 },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const wrap = (name: Call | 'readlink') => {
    const original = real[name] as (...args: unknown[]) => Promise<unknown>;
    return async (...args: unknown[]) => {
      h.calls[name] += 1;
      const error = h.fault?.(name, String(args[0]), h.calls[name]);
      if (error) throw error;
      return original(...args);
    };
  };
  return {
    ...real,
    open: wrap('open'),
    readdir: wrap('readdir'),
    lstat: wrap('lstat'),
    readlink: wrap('readlink'),
  };
});

import { readdirSizesNoFollow, WALK_MAX_DEPTH, walkFilesNoFollow } from '../src/fs-safe.js';

const run = promisify(execFile);
const errnoError = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
const openFds = () => readdirSync('/proc/self/fd').length;
async function collect(walk: AsyncGenerator<{ path: string; size: number }>) {
  const found: string[] = [];
  for await (const entry of walk) found.push(entry.path);
  return found;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'safe-walk-limits-'));
  h.fault = null;
  h.calls = { open: 0, readdir: 0, lstat: 0, readlink: 0 };
});
afterEach(async () => {
  h.fault = null;
  await rm(root, { recursive: true, force: true });
});

/** tree/a/f, tree/b/g, tree/c/h: three directories, listed a, b, c. */
async function threeDirectories() {
  for (const [dir, file] of [
    ['a', 'f'],
    ['b', 'g'],
    ['c', 'h'],
  ] as const) {
    await mkdir(path.join(root, 'tree', dir), { recursive: true });
    await writeFile(path.join(root, 'tree', dir, file), file);
  }
}

describe('a listing that cannot be completed is thrown, never returned short', () => {
  it.each<[string, string, (call: string, target: string, nth: number) => boolean]>([
    [
      'EMFILE',
      'the start directory is opened',
      (call, target) => call === 'open' && target === root,
    ],
    [
      'ENFILE',
      'a child directory is opened',
      (call, target) => call === 'open' && /\/fd\/\d+\/b$/.test(target),
    ],
    ['EMFILE', 'a directory is read', (call, _target, nth) => call === 'readdir' && nth === 2],
    [
      'ENFILE',
      'a file is examined',
      (call, target) => call === 'lstat' && /\/fd\/\d+\/g$/.test(target),
    ],
  ])('%s when %s', async (code, _what, hits) => {
    await threeDirectories();
    h.fault = (call, target, nth) => (hits(call, target, nth) ? errnoError(code) : undefined);
    const before = openFds();

    await expect(collect(walkFilesNoFollow(root, 'tree'))).rejects.toMatchObject({ code });

    expect(openFds()).toBe(before);
  });

  it('still leaves out a directory it is merely refused', async () => {
    await threeDirectories();
    h.fault = (call, target) =>
      call === 'open' && /\/fd\/\d+\/b$/.test(target) ? errnoError('EACCES') : undefined;

    expect(await collect(walkFilesNoFollow(root, 'tree'))).toEqual(['a/f', 'c/h']);
  });
});

describe('the depth the walk will enter', () => {
  const levels = (count: number) => Array.from({ length: count }, () => 'd').join('/');

  it('lists a file in the deepest directory it allows', async () => {
    const deepest = levels(WALK_MAX_DEPTH);
    await mkdir(path.join(root, 'tree', deepest), { recursive: true });
    await writeFile(path.join(root, 'tree', deepest, 'leaf'), 'x');

    expect(await collect(walkFilesNoFollow(root, 'tree'))).toEqual([`${deepest}/leaf`]);
  });

  it('refuses a tree one level deeper, after the files that precede it, and closes every level', async () => {
    await mkdir(path.join(root, 'tree/a'), { recursive: true });
    await writeFile(path.join(root, 'tree/a/first'), 'x');
    await mkdir(path.join(root, 'tree', levels(WALK_MAX_DEPTH + 1)), { recursive: true });
    const before = openFds();
    const seen: string[] = [];

    const walking = (async () => {
      for await (const entry of walkFilesNoFollow(root, 'tree')) seen.push(entry.path);
    })();

    await expect(walking).rejects.toThrow(`${WALK_MAX_DEPTH}-level`);
    expect(seen).toEqual(['a/first']);
    expect(openFds()).toBe(before);
  });
});

describe('the held directory is verified only before an entry is opened or examined', () => {
  it('costs nothing for links, FIFOs and other entries that are never opened', async () => {
    await mkdir(path.join(root, 'tree'));
    for (const name of ['f1', 'f2', 'f3']) await writeFile(path.join(root, 'tree', name), name);
    await collect(walkFilesNoFollow(root, 'tree'));
    const withoutSkipped = h.calls.readlink;

    h.calls.readlink = 0;
    await symlink(path.join(root, 'tree/f1'), path.join(root, 'tree/link-to-file'));
    await symlink(root, path.join(root, 'tree/link-to-directory'));
    await symlink('missing', path.join(root, 'tree/dangling'));
    await run('mkfifo', [path.join(root, 'tree/pipe')]);
    expect(await collect(walkFilesNoFollow(root, 'tree'))).toEqual(['f1', 'f2', 'f3']);

    expect(h.calls.readlink).toBe(withoutSkipped);
  });
});

describe('the directory listing with sizes', () => {
  const files = async () => {
    await mkdir(path.join(root, 'tree'));
    for (const name of ['f1', 'f2', 'f3']) await writeFile(path.join(root, 'tree', name), name);
  };

  it.each<[string, string, (call: string, target: string) => boolean]>([
    ['EMFILE', 'the directory is read', (call) => call === 'readdir'],
    [
      'ENFILE',
      'a file is examined',
      (call, target) => call === 'lstat' && /\/fd\/\d+\/f2$/.test(target),
    ],
  ])('throws %s when %s, never a null size', async (code, _what, hits) => {
    await files();
    h.fault = (call, target) => (hits(call, target) ? errnoError(code) : undefined);
    const before = openFds();

    await expect(readdirSizesNoFollow(root, 'tree')).rejects.toMatchObject({ code });

    expect(openFds()).toBe(before);
  });

  it('still reports no size for a file it is merely refused', async () => {
    await files();
    h.fault = (call, target) =>
      call === 'lstat' && /\/fd\/\d+\/f2$/.test(target) ? errnoError('EACCES') : undefined;

    const listed = await readdirSizesNoFollow(root, 'tree');

    expect(listed?.map((entry) => [entry.name, entry.size]).sort()).toEqual([
      ['f1', 2],
      ['f2', null],
      ['f3', 2],
    ]);
  });

  it('verifies the held directory before each size: once it has moved, no size is read', async () => {
    await files();
    // The directory is renamed just before the first size is read, so the first file is the only
    // one whose check ran while the directory was still in place.
    h.fault = (call) => {
      if (call === 'lstat' && h.calls.lstat === 1) {
        renameSync(path.join(root, 'tree'), path.join(root, 'moved'));
      }
      return undefined;
    };

    const listed = await readdirSizesNoFollow(root, 'tree');

    expect(listed).toHaveLength(3);
    expect(listed?.filter((entry) => entry.size !== null)).toHaveLength(1);
  });
});
