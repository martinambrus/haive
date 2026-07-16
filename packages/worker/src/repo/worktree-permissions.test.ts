import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureSandboxWritableTree, isSandboxWritableTreeRoot } from './worktree-permissions.js';

describe('isSandboxWritableTreeRoot', () => {
  const directory = (uid: number, gid: number, mode: number) => ({
    uid,
    gid,
    mode,
    isDirectory: () => true,
  });

  it('accepts a uid-1000 writable directory', () => {
    expect(isSandboxWritableTreeRoot(directory(1000, 1000, 0o40755))).toBe(true);
    expect(isSandboxWritableTreeRoot(directory(1000, 2000, 0o40755))).toBe(true);
  });

  it('rejects a root-owned directory even when an in-tree marker may exist', () => {
    expect(isSandboxWritableTreeRoot(directory(0, 0, 0o40755))).toBe(false);
  });

  it('rejects a uid-1000 directory without its owner write bit', () => {
    expect(isSandboxWritableTreeRoot(directory(1000, 1000, 0o40555))).toBe(false);
  });
});

const rootIt = process.getuid?.() === 0 ? it : it.skip;

rootIt('repairs a root-owned tree even when the legacy marker is present', async () => {
  const tree = await mkdtemp(path.join(os.tmpdir(), 'haive-worktree-owner-'));
  try {
    const internalDir = path.join(tree, '.haive');
    const marker = path.join(internalDir, '.chowned-1000');
    const trackedLikeFile = path.join(tree, 'tracked.php');
    await mkdir(internalDir);
    await writeFile(marker, '');
    await writeFile(trackedLikeFile, '<?php\n');

    expect((await stat(tree)).uid).toBe(0);
    await ensureSandboxWritableTree(tree);

    expect((await stat(tree)).uid).toBe(1000);
    expect((await stat(marker)).uid).toBe(1000);
    expect((await stat(trackedLikeFile)).uid).toBe(1000);
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
});
