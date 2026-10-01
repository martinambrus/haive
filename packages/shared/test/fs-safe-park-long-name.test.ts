import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileIdentity,
  removeFileIfIdentityNoFollow,
  removeFileIfNoFollow,
  rewriteFileIfNoFollow,
} from '../src/fs-safe.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// NAME_MAX is 255 bytes; the private park name must fit beside any leaf a filesystem accepts.
const LEAVES: [string, string][] = [
  ['198 bytes', 'a'.repeat(194) + '.txt'],
  ['199 bytes', 'a'.repeat(195) + '.txt'],
  ['255 bytes', 'a'.repeat(251) + '.txt'],
  ['multi-byte at the cut', 'é'.repeat(125) + '.txt'],
];

async function fixture(leaf: string) {
  const root = await mkdtemp(join(tmpdir(), 'fs-safe-park-long-'));
  dirs.push(root);
  await writeFile(join(root, leaf), 'old\n');
  return root;
}

describe('a parked remove or rewrite works whatever the length of the name', () => {
  it.each(LEAVES)('rewrites a file whose name is %s', async (_what, leaf) => {
    const root = await fixture(leaf);
    expect(await rewriteFileIfNoFollow(root, leaf, () => Buffer.from('new\n'))).toBe('rewritten');
    expect(await readFile(join(root, leaf), 'utf8')).toBe('new\n');
    expect(await readdir(root)).toEqual([leaf]);
  });

  it.each(LEAVES)('removes a file whose name is %s', async (_what, leaf) => {
    const root = await fixture(leaf);
    expect(await removeFileIfNoFollow(root, leaf, () => true)).toBe('removed');
    expect(await readdir(root)).toEqual([]);
  });

  it.each(LEAVES)('removes by identity a file whose name is %s', async (_what, leaf) => {
    const root = await fixture(leaf);
    const fh = await open(join(root, leaf), 'r');
    try {
      const identity = await fileIdentity(fh);
      expect(await removeFileIfIdentityNoFollow(root, leaf, identity)).toBe('removed');
    } finally {
      await fh.close();
    }
    expect(await readdir(root)).toEqual([]);
  });
});
