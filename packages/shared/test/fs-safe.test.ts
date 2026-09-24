import { execFile, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rename,
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
  isPathContainmentError,
  lstatNoFollow,
  openDirNoFollow,
  openFileNoFollow,
  PathContainmentError,
  readdirNoFollow,
  readFileNoFollow,
  readTextNoFollow,
  relUnder,
  toSafeRel,
} from '../src/fs-safe.js';

const run = promisify(execFile);

describe('toSafeRel', () => {
  it('normalises a plain relative path', () => {
    expect(toSafeRel('')).toBe('');
    expect(toSafeRel('.')).toBe('');
    expect(toSafeRel('./a//b/./c.md')).toBe('a/b/c.md');
    expect(toSafeRel('a/')).toBe('a');
  });

  it('refuses absolute paths, parent segments and NUL', () => {
    for (const bad of ['/etc/passwd', '..', 'a/../b', 'a/..', 'a\0b']) {
      expect(() => toSafeRel(bad)).toThrow(PathContainmentError);
      try {
        toSafeRel(bad);
      } catch (err) {
        expect(isPathContainmentError(err, 'invalid-path')).toBe(true);
      }
    }
  });
});

describe('relUnder', () => {
  it('derives the rel of an absolute path under the anchor', () => {
    expect(relUnder('/repo', '/repo/a/b.md')).toBe('a/b.md');
    expect(relUnder('/repo', '/repo')).toBe('');
    expect(relUnder('/repo/', '/repo/x/../y')).toBe('y');
  });

  it('refuses a path that is not under the anchor', () => {
    expect(() => relUnder('/repo', '/repo2/a')).toThrow(PathContainmentError);
    expect(() => relUnder('/repo', '/repo/../etc')).toThrow(PathContainmentError);
    expect(() => relUnder('/repo', '/')).toThrow(PathContainmentError);
  });
});

describe('isPathContainmentError', () => {
  it('matches by code, with an optional reason', () => {
    const err = new PathContainmentError('link', '/repo', 'a/l', 'a/l');
    expect(isPathContainmentError(err)).toBe(true);
    expect(isPathContainmentError(err, 'link')).toBe(true);
    expect(isPathContainmentError(err, 'out-of-tree')).toBe(false);
    expect(isPathContainmentError({ code: 'EPATHCONTAINMENT', reason: 'link' })).toBe(true);
    expect(isPathContainmentError(new Error('x'))).toBe(false);
    expect(isPathContainmentError(null)).toBe(false);
    expect(err.message).toContain('a/l');
  });
});

// Fixture: `root/a/b.md` is the one honest file. Everything else is a way of reaching somewhere
// else by name — a linked leaf, a linked directory, a dangling link, an in-tree link, a FIFO — plus
// a link TO the root, which must keep working because the anchor is the one component that may be
// followed.
describe('fs-safe reads', () => {
  let root: string;
  let outside: string;
  let rootViaLink: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fs-safe-'));
    outside = await mkdtemp(path.join(tmpdir(), 'fs-safe-out-'));
    await mkdir(path.join(root, 'a', 'dir'), { recursive: true });
    await writeFile(path.join(root, 'a', 'b.md'), 'hello', 'utf8');
    await writeFile(path.join(outside, 'secret.md'), 'elsewhere', 'utf8');
    await symlink(path.join(outside, 'secret.md'), path.join(root, 'a', 'link.md'));
    await symlink('b.md', path.join(root, 'a', 'inlink.md'));
    await symlink(outside, path.join(root, 'linkdir'));
    await symlink('nowhere', path.join(root, 'a', 'dangling.md'));
    await run('mkfifo', [path.join(root, 'a', 'pipe.md')]);
    rootViaLink = path.join(outside, 'rootlink');
    await symlink(root, rootViaLink);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('readTextNoFollow', () => {
    it('reads a regular file, also through a linked anchor', async () => {
      expect(await readTextNoFollow(root, 'a/b.md')).toBe('hello');
      expect(await readTextNoFollow(rootViaLink, 'a/b.md')).toBe('hello');
    });

    it('returns null for anything that is not a regular in-tree file', async () => {
      expect(await readTextNoFollow(root, 'a/missing.md')).toBeNull();
      expect(await readTextNoFollow(root, 'a/link.md')).toBeNull();
      expect(await readTextNoFollow(root, 'a/inlink.md')).toBeNull();
      expect(await readTextNoFollow(root, 'a/dangling.md')).toBeNull();
      expect(await readTextNoFollow(root, 'linkdir/secret.md')).toBeNull();
      expect(await readTextNoFollow(root, 'a/dir')).toBeNull();
      expect(await readTextNoFollow(root, 'a/b.md/x')).toBeNull();
      expect(await readTextNoFollow(root, '')).toBeNull();
      expect(await readTextNoFollow(path.join(root, 'nope'), 'a/b.md')).toBeNull();
    });

    it('never opens a FIFO', async () => {
      // A path-based read here would block forever waiting for a writer.
      expect(await readTextNoFollow(root, 'a/pipe.md')).toBeNull();
    });

    it('throws invalid-path even in lenient mode', async () => {
      await expect(readTextNoFollow(root, '../x')).rejects.toMatchObject({
        code: 'EPATHCONTAINMENT',
        reason: 'invalid-path',
      });
    });

    it('in strict mode names the refused component and keeps absence as null', async () => {
      await expect(readTextNoFollow(root, 'a/link.md', { strict: true })).rejects.toMatchObject({
        reason: 'link',
        at: 'a/link.md',
      });
      await expect(
        readTextNoFollow(root, 'linkdir/secret.md', { strict: true }),
      ).rejects.toMatchObject({ reason: 'link', at: 'linkdir' });
      await expect(readTextNoFollow(root, 'a/dir', { strict: true })).rejects.toMatchObject({
        reason: 'not-regular-file',
      });
      await expect(readTextNoFollow(root, 'a/b.md/x', { strict: true })).rejects.toMatchObject({
        reason: 'not-directory',
        at: 'a/b.md',
      });
      expect(await readTextNoFollow(root, 'a/missing.md', { strict: true })).toBeNull();
    });
  });

  describe('readFileNoFollow', () => {
    it('caps the bytes read and reports the full size', async () => {
      const capped = await readFileNoFollow(root, 'a/b.md', { maxBytes: 3 });
      expect(capped).toMatchObject({ size: 5, truncated: true });
      expect(capped?.data.toString('utf8')).toBe('hel');
      const whole = await readFileNoFollow(root, 'a/b.md', { maxBytes: 10 });
      expect(whole).toMatchObject({ size: 5, truncated: false });
      expect(whole?.data.toString('utf8')).toBe('hello');
    });
  });

  describe('readdirNoFollow', () => {
    it('lists a real directory and the anchor itself', async () => {
      const top = await readdirNoFollow(root, '');
      expect(top?.map((e) => e.name).sort()).toEqual(['a', 'linkdir']);
      const inner = await readdirNoFollow(root, 'a');
      expect(inner?.map((e) => e.name).sort()).toEqual([
        'b.md',
        'dangling.md',
        'dir',
        'inlink.md',
        'link.md',
        'pipe.md',
      ]);
      expect(inner?.find((e) => e.name === 'link.md')?.isSymbolicLink()).toBe(true);
      expect(inner?.find((e) => e.name === 'b.md')?.isFile()).toBe(true);
    });

    it('returns null for a linked, missing or non-directory path', async () => {
      expect(await readdirNoFollow(root, 'linkdir')).toBeNull();
      expect(await readdirNoFollow(root, 'nope')).toBeNull();
      expect(await readdirNoFollow(root, 'a/b.md')).toBeNull();
      await expect(readdirNoFollow(root, 'linkdir', { strict: true })).rejects.toMatchObject({
        reason: 'link',
        at: 'linkdir',
      });
    });
  });

  describe('lstatNoFollow', () => {
    it('reports the kind of the entry without following it', async () => {
      expect((await lstatNoFollow(root, 'a/b.md'))?.kind).toBe('file');
      expect((await lstatNoFollow(root, 'a/dir'))?.kind).toBe('directory');
      expect((await lstatNoFollow(root, ''))?.kind).toBe('directory');
      expect((await lstatNoFollow(root, 'a/link.md'))?.kind).toBe('symlink');
      expect((await lstatNoFollow(root, 'a/dangling.md'))?.kind).toBe('symlink');
      expect((await lstatNoFollow(root, 'a/pipe.md'))?.kind).toBe('other');
      expect(await lstatNoFollow(root, 'a/missing')).toBeNull();
    });

    it('still refuses a link on the way to the entry', async () => {
      expect(await lstatNoFollow(root, 'linkdir/secret.md')).toBeNull();
      await expect(
        lstatNoFollow(root, 'linkdir/secret.md', { strict: true }),
      ).rejects.toMatchObject({ reason: 'link', at: 'linkdir' });
    });
  });

  describe('openFileNoFollow', () => {
    it('hands back a read-write descriptor on the verified inode', async () => {
      const fh = await openFileNoFollow(root, 'a/b.md', 'read-write');
      expect(fh).not.toBeNull();
      try {
        await fh!.truncate(0);
        await fh!.write('HELLO', 0, 'utf8');
      } finally {
        await fh!.close();
      }
      expect(await readTextNoFollow(root, 'a/b.md')).toBe('HELLO');
    });

    it('refuses links, directories and the anchor itself', async () => {
      expect(await openFileNoFollow(root, 'a/link.md', 'read')).toBeNull();
      expect(await openFileNoFollow(root, 'a/dir', 'read')).toBeNull();
      expect(await openFileNoFollow(root, '', 'read')).toBeNull();
      await expect(openFileNoFollow(root, 'a/link.md', 'read', { strict: true })).rejects.toThrow(
        PathContainmentError,
      );
    });
  });
});

describe('openDirNoFollow', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fs-safe-dir-'));
    outside = await mkdtemp(path.join(tmpdir(), 'fs-safe-dir-out-'));
    await mkdir(path.join(root, 'a', 'dir'), { recursive: true });
    await writeFile(path.join(root, 'a', 'b.md'), 'hello', 'utf8');
    await symlink(outside, path.join(root, 'linkdir'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('hands back the directory it walked to', async () => {
    const fh = await openDirNoFollow(root, 'a/dir');
    try {
      expect(await readlink(`/proc/self/fd/${fh.fd}`)).toBe(
        await realpath(path.join(root, 'a/dir')),
      );
    } finally {
      await fh.close();
    }
  });

  it('refuses absence, a link anywhere, a non-directory and the anchor itself', async () => {
    await expect(openDirNoFollow(root, 'a/missing')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(openDirNoFollow(root, 'linkdir')).rejects.toSatisfy((err: unknown) =>
      isPathContainmentError(err, 'link'),
    );
    await expect(openDirNoFollow(root, 'linkdir/x')).rejects.toSatisfy((err: unknown) =>
      isPathContainmentError(err, 'link'),
    );
    await expect(openDirNoFollow(root, 'a/b.md')).rejects.toSatisfy((err: unknown) =>
      isPathContainmentError(err, 'not-directory'),
    );
    await expect(openDirNoFollow(root, '')).rejects.toSatisfy((err: unknown) =>
      isPathContainmentError(err, 'invalid-path'),
    );
  });

  it('keeps a child writing through its slot in the held directory after the name is swapped', async () => {
    // The point of handing a child a descriptor: once held, renaming the directory away and
    // planting a link at its name redirects nothing.
    const fh = await openDirNoFollow(root, 'a/dir');
    try {
      await rename(path.join(root, 'a/dir'), path.join(root, 'a/dir-moved'));
      await symlink(outside, path.join(root, 'a/dir'));
      await new Promise<void>((resolve, reject) => {
        const child = spawn('sh', ['-c', 'echo hi > /proc/self/fd/3/written'], {
          stdio: ['ignore', 'ignore', 'ignore', fh.fd],
        });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    } finally {
      await fh.close();
    }
    expect((await stat(path.join(root, 'a/dir-moved/written'))).isFile()).toBe(true);
    await expect(stat(path.join(outside, 'written'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
