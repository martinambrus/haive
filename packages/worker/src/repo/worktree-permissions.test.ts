import { chmod, chown, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ensureSandboxWritableTree,
  isSandboxWritableTreeRoot,
  sandboxWritableTreeRepair,
} from './worktree-permissions.js';

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

  it('accepts access granted through the sandbox group or other bits', () => {
    expect(isSandboxWritableTreeRoot(directory(2000, 1000, 0o40770))).toBe(true);
    expect(isSandboxWritableTreeRoot(directory(2000, 2000, 0o40757))).toBe(true);
  });

  it('rejects a root-owned directory even when an in-tree marker may exist', () => {
    expect(isSandboxWritableTreeRoot(directory(0, 0, 0o40755))).toBe(false);
  });

  it('rejects a uid-1000 directory without its owner write bit', () => {
    expect(isSandboxWritableTreeRoot(directory(1000, 1000, 0o40555))).toBe(false);
  });

  it('selects a repair the current worker can actually perform', () => {
    const blocked = directory(1001, 1001, 0o40755);
    expect(sandboxWritableTreeRepair(blocked, 0)).toBe('chown');
    expect(sandboxWritableTreeRepair(blocked, 1001)).toBe('chmod-other');
    expect(sandboxWritableTreeRepair(blocked, 2000)).toBe('unavailable');
    expect(sandboxWritableTreeRepair(directory(1001, 1001, 0o40757), 2000)).toBe('none');
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

rootIt('grants sandbox access when a non-root worker owns the tree', async () => {
  const tree = await mkdtemp(path.join(os.tmpdir(), 'haive-worktree-nonroot-owner-'));
  const nested = path.join(tree, 'nested');
  const trackedLikeFile = path.join(nested, 'tracked.php');
  let getuidSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await mkdir(nested);
    await writeFile(trackedLikeFile, '<?php\n');
    await chmod(tree, 0o700);
    await chmod(nested, 0o700);
    await chmod(trackedLikeFile, 0o600);
    await chown(trackedLikeFile, 1001, 1001);
    await chown(nested, 1001, 1001);
    await chown(tree, 1001, 1001);
    getuidSpy = vi.spyOn(process, 'getuid').mockReturnValue(1001);

    await ensureSandboxWritableTree(tree);

    const rootAfter = await stat(tree);
    const nestedAfter = await stat(nested);
    const fileAfter = await stat(trackedLikeFile);
    expect(rootAfter.uid).toBe(1001);
    expect(rootAfter.mode & 0o007).toBe(0o007);
    expect(nestedAfter.mode & 0o007).toBe(0o007);
    expect(fileAfter.mode & 0o007).toBe(0o006);
    expect(isSandboxWritableTreeRoot(rootAfter)).toBe(true);
  } finally {
    getuidSpy?.mockRestore();
    await rm(tree, { recursive: true, force: true });
  }
});
