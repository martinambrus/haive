import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTreeNoFollow,
  chmodNoFollow,
  chownNoFollow,
  copyFileNoFollow,
  ensureDirNoFollow,
  isPathContainmentError,
} from '../src/fs-safe.js';

const run = promisify(execFile);

// The write side of the anchored walk. What these two must never do is act through a link — and the
// destination half is the half a `stat` cannot guard, because a DANGLING link reads as absent and
// the write then lands wherever it points.
describe('fs-safe write primitives', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fs-safe-w-'));
    outside = await mkdtemp(path.join(tmpdir(), 'fs-safe-w-out-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.txt'), 'hello', { encoding: 'utf8', mode: 0o600 });
    await writeFile(path.join(outside, 'secret.txt'), 'elsewhere', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('ensureDirNoFollow', () => {
    it('creates a missing chain and applies the mode to what it created', async () => {
      await ensureDirNoFollow(root, 'a/b/c', { mode: 0o700 });
      expect((await stat(path.join(root, 'a', 'b', 'c'))).isDirectory()).toBe(true);
      // The mode is applied with an explicit chmod, so the umask cannot take bits off it.
      expect((await stat(path.join(root, 'a', 'b', 'c'))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root, 'a'))).mode & 0o777).toBe(0o700);
    });

    it('leaves an existing directory’s mode alone', async () => {
      await mkdir(path.join(root, 'keep'), { mode: 0o755 });
      const before = (await stat(path.join(root, 'keep'))).mode & 0o777;
      await ensureDirNoFollow(root, 'keep/inner', { mode: 0o700 });
      expect((await stat(path.join(root, 'keep'))).mode & 0o777).toBe(before);
      expect((await stat(path.join(root, 'keep', 'inner'))).mode & 0o777).toBe(0o700);
    });

    it('is a no-op for a directory that already exists', async () => {
      await expect(ensureDirNoFollow(root, 'src')).resolves.toBeUndefined();
    });

    it('refuses a linked component instead of creating below it', async () => {
      await symlink(outside, path.join(root, 'linkdir'));
      await expect(ensureDirNoFollow(root, 'linkdir/made')).rejects.toMatchObject({
        code: 'EPATHCONTAINMENT',
        reason: 'link',
        at: 'linkdir',
      });
      // Nothing was created through it.
      await expect(stat(path.join(outside, 'made'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a link where the directory itself would go, live or dangling', async () => {
      await symlink(outside, path.join(root, 'live'));
      await symlink('nowhere', path.join(root, 'dangling'));
      await expect(ensureDirNoFollow(root, 'live')).rejects.toMatchObject({ reason: 'link' });
      await expect(ensureDirNoFollow(root, 'dangling')).rejects.toMatchObject({ reason: 'link' });
    });

    it('refuses a file in the path', async () => {
      await expect(ensureDirNoFollow(root, 'src/a.txt/deeper')).rejects.toMatchObject({
        reason: 'not-directory',
      });
    });
  });

  describe('copyFileNoFollow', () => {
    it('copies the bytes and keeps the source’s mode', async () => {
      await copyFileNoFollow(root, 'src/a.txt', root, 'copy.txt');
      expect(await readFile(path.join(root, 'copy.txt'), 'utf8')).toBe('hello');
      expect((await stat(path.join(root, 'copy.txt'))).mode & 0o777).toBe(0o600);
    });

    it('copies between two anchors', async () => {
      await copyFileNoFollow(root, 'src/a.txt', outside, 'landed.txt');
      expect(await readFile(path.join(outside, 'landed.txt'), 'utf8')).toBe('hello');
    });

    it('creates the destination’s parents only when asked', async () => {
      await expect(copyFileNoFollow(root, 'src/a.txt', root, 'x/y/a.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await copyFileNoFollow(root, 'src/a.txt', root, 'x/y/a.txt', {
        createParents: true,
        mode: 0o750,
      });
      expect(await readFile(path.join(root, 'x', 'y', 'a.txt'), 'utf8')).toBe('hello');
      expect((await stat(path.join(root, 'x'))).mode & 0o777).toBe(0o750);
    });

    it('refuses an existing destination with EEXIST rather than replacing it', async () => {
      await writeFile(path.join(root, 'taken.txt'), 'mine', 'utf8');
      await expect(copyFileNoFollow(root, 'src/a.txt', root, 'taken.txt')).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await readFile(path.join(root, 'taken.txt'), 'utf8')).toBe('mine');
    });

    it('refuses a DANGLING link at the destination, which a stat would call absent', async () => {
      await symlink(path.join(outside, 'planted.txt'), path.join(root, 'dest.txt'));
      await expect(copyFileNoFollow(root, 'src/a.txt', root, 'dest.txt')).rejects.toMatchObject({
        code: 'EEXIST',
      });
      // The whole point: nothing appeared where the link pointed.
      await expect(stat(path.join(outside, 'planted.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // And the link itself is still a link, not a file.
      expect((await lstat(path.join(root, 'dest.txt'))).isSymbolicLink()).toBe(true);
    });

    it('refuses a live link at the destination without touching its target', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'live.txt'));
      await expect(copyFileNoFollow(root, 'src/a.txt', root, 'live.txt')).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
    });

    it('refuses a linked source and a linked directory on either side', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'srclink.txt'));
      await symlink(outside, path.join(root, 'linkdir'));
      await expect(copyFileNoFollow(root, 'srclink.txt', root, 'out1.txt')).rejects.toMatchObject({
        reason: 'link',
      });
      await expect(
        copyFileNoFollow(root, 'linkdir/secret.txt', root, 'out2.txt'),
      ).rejects.toMatchObject({ reason: 'link' });
      await expect(
        copyFileNoFollow(root, 'src/a.txt', root, 'linkdir/out3.txt'),
      ).rejects.toMatchObject({ reason: 'link' });
    });

    it('refuses a source over maxBytes, and a FIFO source', async () => {
      await expect(
        copyFileNoFollow(root, 'src/a.txt', root, 'capped.txt', { maxBytes: 2 }),
      ).rejects.toSatisfy((err: unknown) => isPathContainmentError(err));
      await run('mkfifo', [path.join(root, 'pipe')]);
      await expect(copyFileNoFollow(root, 'pipe', root, 'out4.txt')).rejects.toMatchObject({
        reason: 'not-regular-file',
      });
      await expect(stat(path.join(root, 'capped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('throws for an empty destination rel and for a parent-escaping one', async () => {
      await expect(copyFileNoFollow(root, 'src/a.txt', root, '')).rejects.toMatchObject({
        reason: 'invalid-path',
      });
      await expect(copyFileNoFollow(root, 'src/a.txt', root, '../out.txt')).rejects.toMatchObject({
        reason: 'invalid-path',
      });
    });
  });

  // GNU's capital-X, which is what the shell-outs these replace actually applied: add execute only
  // where it already means something — a directory, or a file that is already executable.
  const uPlusRwX = (mode: number, isDir: boolean): number =>
    mode | 0o600 | (isDir || (mode & 0o111) !== 0 ? 0o100 : 0);

  describe('chmodNoFollow', () => {
    it('sets a mode, takes the callback form, and addresses the anchor itself', async () => {
      await chmodNoFollow(root, 'src/a.txt', 0o640);
      expect((await stat(path.join(root, 'src', 'a.txt'))).mode & 0o777).toBe(0o640);
      await chmodNoFollow(root, 'src/a.txt', uPlusRwX);
      expect((await stat(path.join(root, 'src', 'a.txt'))).mode & 0o777).toBe(0o640);
      await chmodNoFollow(root, 'src', uPlusRwX);
      expect((await stat(path.join(root, 'src'))).mode & 0o700).toBe(0o700);
      await chmodNoFollow(root, '', 0o700);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    });

    it('needs no read permission on the file', async () => {
      // The repair cases this exists for: an app chmodded its own tree to 0000. An O_PATH handle
      // addresses the inode without opening it, so there is nothing to be denied.
      await writeFile(path.join(root, 'locked.txt'), 'x', 'utf8');
      await chmodNoFollow(root, 'locked.txt', 0o000);
      await chmodNoFollow(root, 'locked.txt', 0o600);
      expect((await stat(path.join(root, 'locked.txt'))).mode & 0o777).toBe(0o600);
    });

    it('refuses a linked leaf without touching what it points at', async () => {
      await chmod(path.join(outside, 'secret.txt'), 0o400);
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'srclink.txt'));
      await expect(chmodNoFollow(root, 'srclink.txt', 0o777)).rejects.toMatchObject({
        reason: 'link',
      });
      expect((await stat(path.join(outside, 'secret.txt'))).mode & 0o777).toBe(0o400);
    });

    it('refuses a linked directory component', async () => {
      await symlink(outside, path.join(root, 'linkdir'));
      await expect(chmodNoFollow(root, 'linkdir/secret.txt', 0o777)).rejects.toMatchObject({
        reason: 'link',
        at: 'linkdir',
      });
    });
  });

  describe('chownNoFollow', () => {
    it('refuses a linked leaf', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'srclink.txt'));
      await expect(
        chownNoFollow(root, 'srclink.txt', { uid: process.getuid?.() ?? 0, gid: 0 }),
      ).rejects.toMatchObject({ reason: 'link' });
    });

    it('is a no-op when the owner already matches', async () => {
      const uid = process.getuid?.() ?? 0;
      const gid = process.getgid?.() ?? 0;
      await expect(chownNoFollow(root, 'src/a.txt', { uid, gid })).resolves.toBeUndefined();
    });
  });

  describe('applyTreeNoFollow', () => {
    // `run.sh` is the entry that separates capital-X from a blanket +x, and `link.txt` is the one
    // the recursion must NOT follow — its target is 0400 outside the tree.
    beforeEach(async () => {
      await mkdir(path.join(root, 'tree', 'sub'), { recursive: true });
      await writeFile(path.join(root, 'tree', 'file.txt'), 'a', { encoding: 'utf8', mode: 0o400 });
      await writeFile(path.join(root, 'tree', 'run.sh'), '#!/bin/sh\n', {
        encoding: 'utf8',
        mode: 0o510,
      });
      await writeFile(path.join(root, 'tree', 'sub', 'deep.txt'), 'b', {
        encoding: 'utf8',
        mode: 0o400,
      });
      await chmod(path.join(outside, 'secret.txt'), 0o400);
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'tree', 'link.txt'));
      await chmod(path.join(root, 'tree', 'sub'), 0o500);
      await chmod(path.join(root, 'tree'), 0o500);
    });

    // The fixture leaves `tree` at 0500 on purpose, which is also a directory the outer cleanup
    // cannot unlink inside. Runs innermost-first, so it lands before that `rm`.
    afterEach(async () => {
      for (const dir of ['tree/sub', 'tree']) {
        await chmod(path.join(root, dir), 0o700).catch(() => undefined);
      }
    });

    it('applies capital-X through the tree, skips links and counts what it saw', async () => {
      const res = await applyTreeNoFollow(root, 'tree', { mode: uPlusRwX });
      expect(res).toEqual({ entries: 5, changed: 5, linksSkipped: 1 });
      expect((await stat(path.join(root, 'tree'))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root, 'tree', 'sub'))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root, 'tree', 'sub', 'deep.txt'))).mode & 0o777).toBe(0o600);
      // No execute bit invented for a plain file, and the executable one keeps its own.
      expect((await stat(path.join(root, 'tree', 'file.txt'))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(root, 'tree', 'run.sh'))).mode & 0o777).toBe(0o710);
      // The link was counted, not followed: its target is untouched and still a link here.
      expect((await stat(path.join(outside, 'secret.txt'))).mode & 0o777).toBe(0o400);
      expect((await lstat(path.join(root, 'tree', 'link.txt'))).isSymbolicLink()).toBe(true);
    });

    it('changes nothing on a second pass', async () => {
      await applyTreeNoFollow(root, 'tree', { mode: uPlusRwX });
      const again = await applyTreeNoFollow(root, 'tree', { mode: uPlusRwX });
      expect(again).toEqual({ entries: 5, changed: 0, linksSkipped: 1 });
    });

    it('refuses a link on the way to the tree', async () => {
      await symlink(outside, path.join(root, 'linkdir'));
      await expect(applyTreeNoFollow(root, 'linkdir', { mode: uPlusRwX })).rejects.toMatchObject({
        reason: 'link',
      });
    });
  });
});
