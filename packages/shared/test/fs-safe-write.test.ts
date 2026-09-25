import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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
  openFileNoFollow,
  removeFileIfNoFollow,
  removeNoFollow,
  renameNoFollow,
  updateFileNoFollow,
  writeFileNoFollow,
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

  describe('removeNoFollow', () => {
    it('reports an absent path rather than failing', async () => {
      expect(await removeNoFollow(root, 'nope')).toBe(false);
      expect(await removeNoFollow(root, 'nope/deeper')).toBe(false);
    });

    it('deletes a file, and a tree only when asked', async () => {
      expect(await removeNoFollow(root, 'src/a.txt')).toBe(true);
      await expect(stat(path.join(root, 'src', 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

      await mkdir(path.join(root, 'tree', 'sub'), { recursive: true });
      await writeFile(path.join(root, 'tree', 'sub', 'f.txt'), 'x', 'utf8');
      await expect(removeNoFollow(root, 'tree')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
      expect(await removeNoFollow(root, 'tree', { recursive: true })).toBe(true);
      await expect(stat(path.join(root, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('reports each entry it actually removes, and reports nothing when it removes nothing', async () => {
      // `onRemoved` exists so a caller can tell a removal that FAILED HAVING DELETED SOMETHING
      // from one that failed before touching anything — the thrown error cannot carry that, and
      // the return value never arrives on a throw. The onboarding reset needs the distinction in
      // both directions: superseding its provenance over an intact tree is unrecoverable, and
      // reporting an untouched tree over a half-deleted one is equally wrong.
      let seen: string[] = [];
      const onRemoved = (rel: string) => {
        seen.push(rel);
      };

      // Absent: returns false, having changed nothing, so it must report nothing.
      expect(await removeNoFollow(root, 'nope', { recursive: true, onRemoved })).toBe(false);
      expect(seen).toEqual([]);

      // One file: exactly one report, naming the path the CALLER asked about.
      await writeFile(path.join(root, 'solo.txt'), 'x', 'utf8');
      expect(await removeNoFollow(root, 'solo.txt', { onRemoved })).toBe(true);
      expect(seen).toEqual(['solo.txt']);

      // A tree: one report per entry, directories included, each a rel path under the anchor —
      // which is what lets a caller retire exactly the rows for what actually went.
      seen = [];
      await mkdir(path.join(root, 'many', 'sub'), { recursive: true });
      await writeFile(path.join(root, 'many', 'one.txt'), 'x', 'utf8');
      await writeFile(path.join(root, 'many', 'sub', 'two.txt'), 'x', 'utf8');
      expect(await removeNoFollow(root, 'many', { recursive: true, onRemoved })).toBe(true);
      expect([...seen].sort()).toEqual(
        ['many', 'many/one.txt', 'many/sub', 'many/sub/two.txt'].sort(),
      );

      // A non-recursive failure on a non-empty directory removes nothing and reports nothing.
      seen = [];
      await mkdir(path.join(root, 'full'), { recursive: true });
      await writeFile(path.join(root, 'full', 'x.txt'), 'x', 'utf8');
      await expect(removeNoFollow(root, 'full', { onRemoved })).rejects.toMatchObject({
        code: 'ENOTEMPTY',
      });
      expect(seen).toEqual([]);

      // An EMPTY directory taken non-recursively: its own branch, reached by neither case above,
      // and the shape the reset's swept-dir removal actually uses once every child has gone.
      seen = [];
      await mkdir(path.join(root, 'hollow'), { recursive: true });
      expect(await removeNoFollow(root, 'hollow', { onRemoved })).toBe(true);
      expect(seen).toEqual(['hollow']);
    });

    it('unlinks a link AS a link, leaving its target alone', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'live.txt'));
      expect(await removeNoFollow(root, 'live.txt')).toBe(true);
      await expect(lstat(path.join(root, 'live.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      // The whole point: what it pointed at is still there.
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
    });

    it('unlinks a link found INSIDE a tree rather than descending through it', async () => {
      await mkdir(path.join(root, 'holder'));
      await symlink(outside, path.join(root, 'holder', 'out'));
      expect(await removeNoFollow(root, 'holder', { recursive: true })).toBe(true);
      // The linked-to directory and its contents survive.
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
    });

    it('refuses a linked ancestor, and refuses the anchor itself', async () => {
      await symlink(outside, path.join(root, 'linkdir'));
      await expect(removeNoFollow(root, 'linkdir/secret.txt')).rejects.toMatchObject({
        reason: 'link',
        at: 'linkdir',
      });
      await expect(removeNoFollow(root, '')).rejects.toMatchObject({ reason: 'invalid-path' });
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
    });

    // Drupal ships sites/default at 0555, where nothing may unlink inside it. Root ignores DAC.
    it.skipIf(process.getuid?.() === 0)(
      'removes a 0555 directory only with repairPermissions',
      async () => {
        await mkdir(path.join(root, 'locked', 'inner'), { recursive: true });
        await writeFile(path.join(root, 'locked', 'inner', 'settings.php'), '<?php\n', 'utf8');
        await chmod(path.join(root, 'locked', 'inner'), 0o555);
        await chmod(path.join(root, 'locked'), 0o555);
        try {
          await expect(removeNoFollow(root, 'locked', { recursive: true })).rejects.toMatchObject({
            code: 'EACCES',
          });
          expect(
            await removeNoFollow(root, 'locked', { recursive: true, repairPermissions: true }),
          ).toBe(true);
          await expect(stat(path.join(root, 'locked'))).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          await chmod(path.join(root, 'locked'), 0o700).catch(() => undefined);
          await chmod(path.join(root, 'locked', 'inner'), 0o700).catch(() => undefined);
        }
      },
    );
  });

  describe('removeFileIfNoFollow', () => {
    const is = (text: string) => (data: Buffer) => data.toString('utf8') === text;

    it('removes a file its check accepts, and keeps one it refuses on the same inode', async () => {
      const file = path.join(root, 'src', 'a.txt');
      const ino = (await stat(file)).ino;
      expect(await removeFileIfNoFollow(root, 'src/a.txt', is('other'))).toBe('kept');
      expect(await readFile(file, 'utf8')).toBe('hello');
      expect((await stat(file)).ino).toBe(ino);
      expect(await removeFileIfNoFollow(root, 'src/a.txt', is('hello'))).toBe('removed');
      expect(await readdir(path.join(root, 'src'))).toEqual([]);
    });

    it('reports an absent file and an absent parent without calling the check', async () => {
      const never = () => expect.unreachable();
      expect(await removeFileIfNoFollow(root, 'src/none.txt', never)).toBe('absent');
      expect(await removeFileIfNoFollow(root, 'none/a.txt', never)).toBe('absent');
    });

    it('keeps a link, a directory and a file over maxBytes without reading them', async () => {
      const never = () => expect.unreachable();
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'src', 'link.txt'));
      await mkdir(path.join(root, 'src', 'dir'));
      expect(await removeFileIfNoFollow(root, 'src/link.txt', never)).toBe('kept');
      expect(await removeFileIfNoFollow(root, 'src/dir', never)).toBe('kept');
      expect(await removeFileIfNoFollow(root, 'src/a.txt', never, { maxBytes: 2 })).toBe('kept');
      expect((await lstat(path.join(root, 'src', 'link.txt'))).isSymbolicLink()).toBe(true);
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
      expect(await readFile(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('hello');
    });

    it('refuses a linked ancestor and an empty rel', async () => {
      await symlink(outside, path.join(root, 'via'));
      await expect(
        removeFileIfNoFollow(root, 'via/secret.txt', is('elsewhere')),
      ).rejects.toMatchObject({ reason: 'link' });
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
      await expect(removeFileIfNoFollow(root, '', is('x'))).rejects.toThrow();
    });

    it('never takes a file written at the path while the old one is judged', async () => {
      const file = path.join(root, 'src', 'a.txt');
      const result = await removeFileIfNoFollow(root, 'src/a.txt', async (data) => {
        await writeFile(file, 'PERSON', 'utf8');
        return data.toString('utf8') === 'hello';
      });
      expect(result).toBe('removed');
      expect(await readFile(file, 'utf8')).toBe('PERSON');
    });

    it('leaves a refused file parked, and names where, when its name was taken meanwhile', async () => {
      const file = path.join(root, 'src', 'a.txt');
      await expect(
        removeFileIfNoFollow(root, 'src/a.txt', async () => {
          await writeFile(file, 'PERSON', 'utf8');
          return false;
        }),
      ).rejects.toThrow(/could not be put back \(EEXIST\); it is at src\/\.a\.txt\.haive-rm-/);
      expect(await readFile(file, 'utf8')).toBe('PERSON');
      const parked = (await readdir(path.join(root, 'src'))).filter((n) => n !== 'a.txt');
      expect(parked).toHaveLength(1);
      expect(await readFile(path.join(root, 'src', parked[0]!), 'utf8')).toBe('hello');
    });
  });

  describe('renameNoFollow', () => {
    it('moves within an anchor and between two anchors', async () => {
      await renameNoFollow(root, 'src/a.txt', 'moved.txt');
      expect(await readFile(path.join(root, 'moved.txt'), 'utf8')).toBe('hello');
      await renameNoFollow(root, 'moved.txt', 'landed.txt', { toAnchor: outside });
      expect(await readFile(path.join(outside, 'landed.txt'), 'utf8')).toBe('hello');
    });

    it('creates the destination parents only when asked', async () => {
      await expect(renameNoFollow(root, 'src/a.txt', 'x/y/a.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await renameNoFollow(root, 'src/a.txt', 'x/y/a.txt', { createParents: true, mode: 0o750 });
      expect(await readFile(path.join(root, 'x', 'y', 'a.txt'), 'utf8')).toBe('hello');
      expect((await stat(path.join(root, 'x'))).mode & 0o777).toBe(0o750);
    });

    it('refuses a linked source leaf and a linked ancestor on either side', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'srclink.txt'));
      await symlink(outside, path.join(root, 'linkdir'));
      await expect(renameNoFollow(root, 'srclink.txt', 'out.txt')).rejects.toMatchObject({
        reason: 'link',
      });
      await expect(renameNoFollow(root, 'linkdir/secret.txt', 'out.txt')).rejects.toMatchObject({
        reason: 'link',
      });
      await expect(renameNoFollow(root, 'src/a.txt', 'linkdir/out.txt')).rejects.toMatchObject({
        reason: 'link',
      });
      // Nothing moved through any of them.
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
      expect(await readFile(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('hello');
    });

    it('replaces an existing destination by default', async () => {
      await writeFile(path.join(root, 'taken.txt'), 'mine', 'utf8');
      await renameNoFollow(root, 'src/a.txt', 'taken.txt');
      expect(await readFile(path.join(root, 'taken.txt'), 'utf8')).toBe('hello');
    });

    it('noReplace refuses an existing destination, and a DANGLING link at it', async () => {
      await writeFile(path.join(root, 'taken.txt'), 'mine', 'utf8');
      await expect(
        renameNoFollow(root, 'src/a.txt', 'taken.txt', { noReplace: true }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(path.join(root, 'taken.txt'), 'utf8')).toBe('mine');

      // A stat would call this destination free, and the move would land on its target.
      await symlink(path.join(outside, 'planted.txt'), path.join(root, 'dangling.txt'));
      await expect(
        renameNoFollow(root, 'src/a.txt', 'dangling.txt', { noReplace: true }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(stat(path.join(outside, 'planted.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('hello');
    });

    it('noReplace moves a directory and refuses a taken name', async () => {
      await mkdir(path.join(root, 'from', 'inner'), { recursive: true });
      await writeFile(path.join(root, 'from', 'inner', 'f.txt'), 'x', 'utf8');
      await renameNoFollow(root, 'from', 'to', { noReplace: true });
      expect(await readFile(path.join(root, 'to', 'inner', 'f.txt'), 'utf8')).toBe('x');

      await mkdir(path.join(root, 'again'));
      await expect(renameNoFollow(root, 'to', 'again', { noReplace: true })).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect((await stat(path.join(root, 'to'))).isDirectory()).toBe(true);
    });

    it('noReplace takes its claim back when the directory cannot be moved into it', async () => {
      // The claim is an empty directory made before the move; left behind, it holds the name for
      // good. A directory cannot be moved inside itself, so this move fails after the claim.
      await mkdir(path.join(root, 'from', 'inner'), { recursive: true });
      await expect(
        renameNoFollow(root, 'from', 'from/inner/claim', { noReplace: true }),
      ).rejects.toMatchObject({ code: 'EINVAL' });
      expect(await readdir(path.join(root, 'from', 'inner'))).toEqual([]);
    });

    it('refuses an empty rel on either side', async () => {
      await expect(renameNoFollow(root, '', 'x.txt')).rejects.toMatchObject({
        reason: 'invalid-path',
      });
      await expect(renameNoFollow(root, 'src/a.txt', '')).rejects.toMatchObject({
        reason: 'invalid-path',
      });
    });
  });

  describe('openFileNoFollow create-exclusive', () => {
    it('creates a file with the asked-for mode and never returns null', async () => {
      const fh = await openFileNoFollow(root, 'made.txt', 'create-exclusive', { fileMode: 0o640 });
      try {
        await fh.write(Buffer.from('hi', 'utf8'), 0, 2, 0);
      } finally {
        await fh.close();
      }
      expect(await readFile(path.join(root, 'made.txt'), 'utf8')).toBe('hi');
      expect((await stat(path.join(root, 'made.txt'))).mode & 0o777).toBe(0o640);
    });

    it('refuses an existing file, and a DANGLING link an access probe calls free', async () => {
      await expect(openFileNoFollow(root, 'src/a.txt', 'create-exclusive')).rejects.toMatchObject({
        code: 'EEXIST',
      });

      await symlink(path.join(outside, 'planted.txt'), path.join(root, 'dangling.txt'));
      await expect(
        openFileNoFollow(root, 'dangling.txt', 'create-exclusive'),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      // Nothing was created through the link.
      await expect(stat(path.join(outside, 'planted.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('refuses a linked ancestor and creates parents only when asked', async () => {
      await symlink(outside, path.join(root, 'linkdir'));
      await expect(
        openFileNoFollow(root, 'linkdir/made.txt', 'create-exclusive'),
      ).rejects.toMatchObject({ reason: 'link' });
      await expect(
        openFileNoFollow(root, 'deep/made.txt', 'create-exclusive'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const fh = await openFileNoFollow(root, 'deep/made.txt', 'create-exclusive', {
        createParents: true,
      });
      await fh.close();
      expect((await stat(path.join(root, 'deep', 'made.txt'))).isFile()).toBe(true);
    });
  });

  describe('writeFileNoFollow', () => {
    it('replaces atomically, inheriting the replaced file’s mode', async () => {
      expect(await writeFileNoFollow(root, 'src/a.txt', 'next')).toBe('overwritten');
      expect(await readFile(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('next');
      // 0600 came from the fixture, not from the default.
      expect((await stat(path.join(root, 'src', 'a.txt'))).mode & 0o777).toBe(0o600);
      // No temp left beside it.
      expect((await readdir(path.join(root, 'src'))).sort()).toEqual(['a.txt']);
    });

    it('creates a missing file and reports which it did', async () => {
      expect(await writeFileNoFollow(root, 'fresh.txt', 'x', { fileMode: 0o600 })).toBe('created');
      expect((await stat(path.join(root, 'fresh.txt'))).mode & 0o777).toBe(0o600);
    });

    it('overwrite-in-place keeps the inode, so a holder sees the new bytes', async () => {
      const before = await stat(path.join(root, 'src', 'a.txt'));
      expect(
        await writeFileNoFollow(root, 'src/a.txt', 'inplace', { mode: 'overwrite-in-place' }),
      ).toBe('overwritten');
      const after = await stat(path.join(root, 'src', 'a.txt'));
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('inplace');
    });

    it('refuses a link at the leaf in every mode, target untouched', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'live.txt'));
      for (const mode of ['replace-atomic', 'overwrite-in-place'] as const) {
        await expect(writeFileNoFollow(root, 'live.txt', 'x', { mode })).rejects.toMatchObject({
          reason: 'link',
        });
      }
      await expect(
        writeFileNoFollow(root, 'live.txt', 'x', { mode: 'create-exclusive' }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
    });

    it('refuses a directory at the leaf and an empty rel', async () => {
      await expect(writeFileNoFollow(root, 'src', 'x')).rejects.toMatchObject({
        reason: 'not-regular-file',
      });
      await expect(writeFileNoFollow(root, '', 'x')).rejects.toMatchObject({
        reason: 'invalid-path',
      });
    });

    it('replaceLeafLink replaces a link AS a link and inherits nothing from it', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'live.txt'));
      await symlink(path.join(outside, 'nowhere.txt'), path.join(root, 'dangling.txt'));
      for (const name of ['live.txt', 'dangling.txt']) {
        expect(await writeFileNoFollow(root, name, 'generated', { replaceLeafLink: true })).toBe(
          'overwritten',
        );
        const st = await lstat(path.join(root, name));
        expect(st.isFile()).toBe(true);
        // A link's own mode is 0777; the file written in its place must not carry it on.
        expect(st.mode & 0o777).toBe(0o644);
        expect(await readFile(path.join(root, name), 'utf8')).toBe('generated');
      }
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
      await expect(lstat(path.join(outside, 'nowhere.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // Only a LINK is replaced: anything else at the name is still refused.
      await expect(
        writeFileNoFollow(root, 'src', 'x', { replaceLeafLink: true }),
      ).rejects.toMatchObject({ reason: 'not-regular-file' });
    });
  });

  describe('updateFileNoFollow', () => {
    it('hands the current content to the updater and writes back what it returns', async () => {
      expect(await updateFileNoFollow(root, 'src/a.txt', (cur) => `${cur} world`)).toBe('updated');
      expect(await readFile(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('hello world');
    });

    it('writes SHORTER content with no hole in front of it', async () => {
      // The trap this primitive exists to avoid: writing through a handle that has just been read
      // lands at the old EOF, and `truncate` does not move the offset — so the file comes back
      // NUL-padded. Asserted on the byte length, which a trimmed string comparison would hide.
      await writeFile(path.join(root, 'src', 'a.txt'), 'a'.repeat(500), 'utf8');
      await updateFileNoFollow(root, 'src/a.txt', () => 'tiny');
      const buf = await readFile(path.join(root, 'src', 'a.txt'));
      expect(buf.length).toBe(4);
      expect(buf.toString('utf8')).toBe('tiny');
    });

    it('keeps the inode, owner and mode of the file it updates', async () => {
      const before = await stat(path.join(root, 'src', 'a.txt'));
      await updateFileNoFollow(root, 'src/a.txt', (cur) => `${cur}!`);
      const after = await stat(path.join(root, 'src', 'a.txt'));
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
      expect(after.uid).toBe(before.uid);
    });

    it('writes nothing when the updater returns null or the identical string', async () => {
      const before = await stat(path.join(root, 'src', 'a.txt'));
      expect(await updateFileNoFollow(root, 'src/a.txt', () => null)).toBe('unchanged');
      expect(await updateFileNoFollow(root, 'src/a.txt', (cur) => cur)).toBe('unchanged');
      const after = await stat(path.join(root, 'src', 'a.txt'));
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(await readFile(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('hello');
    });

    it('creates the file, and its parents, only when asked to', async () => {
      await expect(updateFileNoFollow(root, 'src/new.txt', () => 'x')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const made = await updateFileNoFollow(
        root,
        'deep/er/new.txt',
        (cur) => {
          expect(cur).toBeNull();
          return 'fresh';
        },
        { create: true, createParents: true },
      );
      expect(made).toBe('created');
      expect(await readFile(path.join(root, 'deep', 'er', 'new.txt'), 'utf8')).toBe('fresh');
    });

    it('creates nothing when the updater declines an absent file', async () => {
      expect(await updateFileNoFollow(root, 'src/absent.txt', () => null, { create: true })).toBe(
        'unchanged',
      );
      await expect(stat(path.join(root, 'src', 'absent.txt'))).rejects.toThrow();
    });

    it('refuses a link at the leaf and leaves its target alone', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
      await expect(
        updateFileNoFollow(root, 'link.txt', () => 'rewritten', { create: true }),
      ).rejects.toMatchObject({ reason: 'link' });
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
    });

    it('refuses a linked ancestor', async () => {
      await symlink(outside, path.join(root, 'linkdir'));
      await expect(
        updateFileNoFollow(root, 'linkdir/secret.txt', (cur) => `${cur} no`),
      ).rejects.toMatchObject({ reason: 'link' });
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('elsewhere');
    });

    it('refuses a file over maxBytes rather than reading part of it', async () => {
      await expect(
        updateFileNoFollow(root, 'src/a.txt', (cur) => `${cur}!`, { maxBytes: 2 }),
      ).rejects.toThrow(/over the 2 byte update cap/);
      expect(await readFile(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('hello');
    });
  });
});
