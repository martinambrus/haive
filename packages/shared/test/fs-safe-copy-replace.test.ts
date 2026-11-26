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
      const entries = await safe.readdirNoFollow(root, 'tree', {
        strict: true,
        maxEntries: 4,
        recoverParks: true,
      });
      expect(entries?.some((entry) => entry.name === parked)).toBe(false);
      expect(await readFile(path.join(root, 'tree/file'), 'utf8')).toBe(
        published ? 'new public bytes' : 'original',
      );
      if (published) {
        const kept = entries!.find((entry) => entry.name.includes('.haive-alias-kept-'))!;
        expect(await readFile(path.join(root, 'tree', kept.name), 'utf8')).toBe('original');
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
  await safe.readdirNoFollow(root, 'tree', { strict: true, maxEntries: 4, recoverParks: true });
  expect(await readFile(path.join(root, 'tree', leaf), 'utf8')).toBe('original');
});
