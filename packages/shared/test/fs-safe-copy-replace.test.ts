import {
  mkdtemp,
  mkdir,
  writeFile,
  link,
  readFile,
  lstat,
  rm,
  rename,
  symlink,
  open,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as safe from '../src/fs-safe.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'copy-replace-'));
  roots.push(root);
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'outside'), 'original', { mode: 0o640 });
  await link(path.join(root, 'outside'), path.join(root, 'tree/file'));
  const identity = await lstat(path.join(root, 'tree/file'), { bigint: true });
  return { root, identity };
}

describe('copyReplaceFileIfIdentityNoFollow', () => {
  it('detaches only the held name, preserving bytes, mode, owner and mtime', async () => {
    expect(safe.COPY_REPLACE_MAX_BYTES).toBe(256 * 1024 * 1024);
    const { root, identity } = await fixture();
    expect(
      await safe.copyReplaceFileIfIdentityNoFollow(root, 'tree/file', identity, {
        internalNames: 1,
      }),
    ).toBe('replaced');
    const after = await lstat(path.join(root, 'tree/file'), { bigint: true });
    expect(after.ino).not.toBe(identity.ino);
    expect([after.mode, after.uid, after.gid]).toEqual([identity.mode, identity.uid, identity.gid]);
    expect(Math.abs(Number(after.mtimeNs - identity.mtimeNs))).toBeLessThan(1000);
    await writeFile(path.join(root, 'outside'), 'changed');
    expect(await readFile(path.join(root, 'tree/file'), 'utf8')).toBe('original');
    expect(
      await safe.copyReplaceFileIfIdentityNoFollow(root, 'tree/file', after, { internalNames: 1 }),
    ).toBe('unneeded');
  });
  it('keeps a replacement, refuses a parent link and never reads an oversized source', async () => {
    const { root, identity } = await fixture();
    await expect(
      safe.copyReplaceFileIfIdentityNoFollow(root, 'tree/file', identity, {
        internalNames: 1,
        maxBytes: 2,
      }),
    ).rejects.toThrow(RangeError);
    expect((await lstat(path.join(root, 'tree/file'), { bigint: true })).ino).toBe(identity.ino);
    await rm(path.join(root, 'tree/file'));
    await writeFile(path.join(root, 'tree/file'), 'new');
    expect(
      await safe.copyReplaceFileIfIdentityNoFollow(root, 'tree/file', identity, {
        internalNames: 1,
      }),
    ).toBe('changed');
    await symlink('tree', path.join(root, 'redirect'));
    await expect(
      safe.copyReplaceFileIfIdentityNoFollow(root, 'redirect/file', identity, { internalNames: 1 }),
    ).rejects.toMatchObject({ code: 'EPATHCONTAINMENT' });
    expect(await readFile(path.join(root, 'outside'), 'utf8')).toBe('original');
  });
});

describe('interrupted alias replacement recovery', () => {
  it.each([false, true])(
    'recovers immediately after park/publication (published=%s)',
    async (published) => {
      const { root } = await fixture();
      const parked = '.file.haive-alias-park-123-11111111-1111-1111-1111-111111111111';
      await rename(path.join(root, 'tree/file'), path.join(root, 'tree', parked));
      if (published) await writeFile(path.join(root, 'tree/file'), 'new public bytes');
      await safe.recoverWorktreeAliasArtifactsNoFollow(
        root,
        'tree',
        await readdir(path.join(root, 'tree')),
      );
      const entries = await safe.readdirNoFollow(root, 'tree', {
        strict: true,
        maxEntries: 4,
      });
      expect(entries?.some((entry) => entry.name === parked)).toBe(false);
      expect(await readFile(path.join(root, 'tree/file'), 'utf8')).toBe(
        published ? 'new public bytes' : 'original',
      );
      if (published) {
        const parent = await lstat(path.join(root, 'tree'));
        const recoveredParent = await lstat(path.join(root, 'tree/.haive'));
        expect(recoveredParent.mode & 0o777).toBe(0o755);
        expect([recoveredParent.uid, recoveredParent.gid]).toEqual([parent.uid, parent.gid]);
        const [kept] = await readdir(path.join(root, 'tree/.haive/alias-recovery'));
        expect(await readFile(path.join(root, 'tree/.haive/alias-recovery', kept!), 'utf8')).toBe(
          'original',
        );
      }
      expect(await readFile(path.join(root, 'outside'), 'utf8')).toBe('original');
    },
  );
});

it('refuses a source edit arriving during copy fsync and restores its current bytes', async () => {
  const { root, identity } = await fixture();
  const sample = await open(path.join(root, 'outside'));
  const prototype = Object.getPrototypeOf(sample);
  const sync = prototype.sync;
  await sample.close();
  let changed = false;
  vi.spyOn(prototype, 'sync').mockImplementation(async function (
    this: import('node:fs/promises').FileHandle,
  ) {
    if (!changed) {
      changed = true;
      await writeFile(path.join(root, 'outside'), 'new legitimate edit');
    }
    return sync.call(this);
  });
  await expect(
    safe.copyReplaceFileIfIdentityNoFollow(root, 'tree/file', identity, { internalNames: 1 }),
  ).rejects.toThrow(/source changed/);
  expect(await readFile(path.join(root, 'tree/file'), 'utf8')).toBe('new legitimate edit');
  expect((await lstat(path.join(root, 'tree/file'), { bigint: true })).ino).toBe(identity.ino);
});
it('recovers a truncated alias park with its companion record in either listing order', async () => {
  const { root } = await fixture();
  const leaf = 'x'.repeat(140);
  const parked = `.${leaf.slice(0, 100)}.haive-alias-park-123-11111111-1111-1111-1111-111111111111`;
  await rename(path.join(root, 'tree/file'), path.join(root, 'tree', parked));
  await writeFile(path.join(root, 'tree', `${parked}.name`), leaf);
  await safe.recoverWorktreeAliasArtifactsNoFollow(
    root,
    'tree',
    await readdir(path.join(root, 'tree')),
  );
  expect(await readFile(path.join(root, 'tree', leaf), 'utf8')).toBe('original');
});

it('M3 keeps the public name readable throughout copying and fsync', async () => {
  const { root, identity } = await fixture();
  const sample = await open(path.join(root, 'outside'));
  const proto = Object.getPrototypeOf(sample);
  const sync = proto.sync;
  await sample.close();
  let observations = 0;
  vi.spyOn(proto, 'sync').mockImplementation(async function (
    this: import('node:fs/promises').FileHandle,
  ) {
    expect(await readFile(path.join(root, 'tree/file'), 'utf8')).toBe('original');
    observations++;
    return sync.call(this);
  });
  await safe.copyReplaceFileIfIdentityNoFollow(root, 'tree/file', identity, { internalNames: 1 });
  expect(observations).toBeGreaterThan(0);
});
it('L1 strips privileged permission bits while retaining ordinary permissions', async () => {
  const { root } = await fixture();
  const fh = await open(path.join(root, 'outside'), 'r+');
  await fh.chmod(0o7640);
  const identity = await fh.stat({ bigint: true });
  await fh.close();
  await safe.copyReplaceFileIfIdentityNoFollow(root, 'tree/file', identity, { internalNames: 1 });
  expect((await lstat(path.join(root, 'tree/file'))).mode & 0o7777).toBe(0o640);
});
it('L3 directory reads never recover parks', async () => {
  const { root } = await fixture();
  const parked = '.file.haive-alias-park-123-11111111-1111-1111-1111-111111111111';
  await rename(path.join(root, 'tree/file'), path.join(root, 'tree', parked));
  // An older JavaScript caller may still pass the removed option. A read must remain a read.
  const legacyOptions = { strict: true, maxEntries: 4, recoverParks: true };
  const entries = await safe.readdirNoFollow(root, 'tree', legacyOptions);
  expect(entries?.map((e) => e.name)).toContain(parked);
  await expect(lstat(path.join(root, 'tree/file'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('I2 syncs the containing directory after publication, before reporting success', async () => {
  const { root, identity } = await fixture();
  const sample = await open(path.join(root, 'outside'));
  const proto = Object.getPrototypeOf(sample);
  const sync = proto.sync;
  await sample.close();
  const synced: string[] = [];
  vi.spyOn(proto, 'sync').mockImplementation(async function (
    this: import('node:fs/promises').FileHandle,
  ) {
    const st = await this.stat();
    synced.push(st.isDirectory() ? 'directory' : 'file');
    if (st.isDirectory())
      expect((await lstat(path.join(root, 'tree/file'), { bigint: true })).ino).not.toBe(
        identity.ino,
      );
    return sync.call(this);
  });
  await safe.copyReplaceFileIfIdentityNoFollow(root, 'tree/file', identity, { internalNames: 1 });
  expect(synced).toEqual(['file', 'directory']);
});

it('I1 still syncs and closes every held descriptor if closing the original rejects', async () => {
  const { root, identity } = await fixture();
  const sample = await open(path.join(root, 'outside'));
  const proto = Object.getPrototypeOf(sample);
  const stat = proto.stat;
  await sample.close();
  let injected = false;
  vi.spyOn(proto, 'stat').mockImplementation(async function (
    this: import('node:fs/promises').FileHandle,
    ...args: unknown[]
  ) {
    const result = await stat.apply(this, args);
    if (!injected && result.ino === identity.ino) {
      injected = true;
      const close = this.close.bind(this);
      vi.spyOn(this, 'close').mockImplementation(async () => {
        await close();
        throw new Error('close rejected');
      });
    }
    return result;
  });
  const descriptors = (await readdir('/proc/self/fd')).length;
  await expect(
    safe.copyReplaceFileIfIdentityNoFollow(root, 'tree/file', identity, { internalNames: 1 }),
  ).resolves.toBe('replaced');
  expect(injected).toBe(true);
  expect((await readdir('/proc/self/fd')).length).toBe(descriptors);
});
