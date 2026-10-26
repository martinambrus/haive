import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({
  afterRename: null as null | (() => Promise<void>),
  beforeRename: null as null | (() => Promise<void>),
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (...args: Parameters<typeof real.rename>) => {
      const before = hooks.beforeRename;
      hooks.beforeRename = null;
      await before?.();
      await real.rename(...args);
      const hook = hooks.afterRename;
      hooks.afterRename = null;
      await hook?.();
    },
  };
});
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  inspectJournalFilesNoFollow,
  prepareJournalFilesNoFollow,
  rewriteFileIfNoFollow,
  removeFileIfNoFollow,
  restoreJournalFileNoFollow,
  writeFileNoFollow,
  ParkedFileError,
} from '../src/fs-safe.js';
let root: string;
const metadata = { uid: process.getuid!(), gid: process.getgid!(), mode: 0o640 };
const prepare = (before: string | null = 'before', after: string | null = 'after') =>
  prepareJournalFilesNoFollow(
    root,
    '.haive-data/.state-writes/' + randomUUID(),
    [{ before, after, metadata: before === null ? null : metadata }],
    1024 * 1024,
  );
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fs-journal-'));
  await writeFile(join(root, 'record'), 'before', { mode: metadata.mode });
});
afterEach(async () => {
  hooks.afterRename = null;
  hooks.beforeRename = null;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const change = (data: Buffer) => (data.equals(Buffer.from('before')) ? Buffer.from('after') : null);
describe('prepared journal filesystem operations', () => {
  it('does not classify disappearance of the private rename destination as public absence', async () => {
    const prepared = await prepare();
    hooks.beforeRename = () => rm(join(root, prepared.rel), { recursive: true });
    await expect(
      rewriteFileIfNoFollow(root, 'record', change, {
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).rejects.toMatchObject({ code: 'EPATHCONTAINMENT' });
    expect(await readFile(join(root, 'record'), 'utf8')).toBe('before');
  });

  it.each(['rewrite', 'remove'] as const)(
    'matches generic %s absence when the source vanishes at the actual rename',
    async (mode) => {
      const prepared = await prepare();
      await writeFile(join(root, 'control'), 'before');
      hooks.beforeRename = () => rm(join(root, 'control'));
      const generic =
        mode === 'rewrite'
          ? await rewriteFileIfNoFollow(root, 'control', change, { maxBytes: 1024 * 1024 })
          : await removeFileIfNoFollow(root, 'control', () => true, { maxBytes: 1024 * 1024 });
      expect(generic).toBe('absent');
      hooks.beforeRename = () => rm(join(root, 'record'));
      const options = {
        maxBytes: 1024 * 1024,
        journal: { prepared, index: 0, direction: 'forward' as const },
      };
      const result =
        mode === 'rewrite'
          ? await rewriteFileIfNoFollow(root, 'record', change, options)
          : await removeFileIfNoFollow(root, 'record', () => true, options);
      expect(result).toBe('absent');
      expect(
        (await inspectJournalFilesNoFollow(root, prepared, 1024 * 1024))[0]!.forward.kind,
      ).toBe('absent');
    },
  );
  it.each(['rewrite', 'remove'] as const)(
    'matches generic %s absence for a missing public parent',
    async (mode) => {
      const prepared = await prepare();
      const options = {
        maxBytes: 1024 * 1024,
        journal: { prepared, index: 0, direction: 'forward' as const },
      };
      const generic =
        mode === 'rewrite'
          ? await rewriteFileIfNoFollow(root, 'gone/control', change)
          : await removeFileIfNoFollow(root, 'gone/control', () => true);
      expect(generic).toBe('absent');
      const result =
        mode === 'rewrite'
          ? await rewriteFileIfNoFollow(root, 'gone/record', change, options)
          : await removeFileIfNoFollow(root, 'gone/record', () => true, options);
      expect(result).toBe('absent');
    },
  );
  it('keeps changed bytes and still rejects a corrupt private capability on an absent public path', async () => {
    const prepared = await prepare();
    await writeFile(join(root, 'record'), 'editor');
    expect(
      await rewriteFileIfNoFollow(root, 'record', change, {
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).toBe('kept');
    expect(await readFile(join(root, 'record'), 'utf8')).toBe('editor');
    await rename(join(root, prepared.rel), join(root, 'saved-capability'));
    await mkdir(join(root, prepared.rel), { mode: 0o700 });
    await expect(
      rewriteFileIfNoFollow(root, 'gone/record', change, {
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).rejects.toThrow();
  });

  it('bounds aggregate inspection by recorded lengths when all published image aliases grow', async () => {
    const count = 32;
    const prepared = await prepareJournalFilesNoFollow(
      root,
      '.haive-data/.state-writes/' + randomUUID(),
      Array.from({ length: count }, () => ({ before: 'a', after: 'b', metadata })),
      1024 * 1024,
    );
    for (let index = 0; index < count; index++) {
      await writeFileNoFollow(root, 'alias' + index, 'b', {
        mode: 'create-exclusive',
        journal: { prepared, index, direction: 'forward' },
      });
      await writeFile(join(root, 'alias' + index), Buffer.alloc(1024 * 1024, 120));
    }
    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    const inspected = await inspectJournalFilesNoFollow(
      root,
      prepared,
      1024 * 1024,
      Array(count).fill(1),
    );
    expect(alloc.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0)).toBeLessThanOrEqual(
      4 * count,
    );
    expect(inspected.every((entry) => entry.after.truncated)).toBe(true);
    expect(
      inspected.reduce(
        (total, entry) =>
          total + (entry.before.data?.length ?? 0) + (entry.after.data?.length ?? 0),
        0,
      ),
    ).toBe(count);
    expect((await stat(join(root, 'alias0'))).size).toBe(1024 * 1024);
  });

  it('refuses a mode changed after preparation, while generic CAS preserves that mode', async () => {
    const prepared = await prepare();
    await writeFile(join(root, 'control'), 'before', { mode: metadata.mode });
    await chmod(join(root, 'record'), 0o600);
    await chmod(join(root, 'control'), 0o600);
    expect(await rewriteFileIfNoFollow(root, 'control', change, { maxBytes: 1024 * 1024 })).toBe(
      'rewritten',
    );
    expect((await stat(join(root, 'control'))).mode & 0o7777).toBe(0o600);
    expect(
      await rewriteFileIfNoFollow(root, 'record', change, {
        maxBytes: 1024 * 1024,
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).toBe('kept');
    expect(await readFile(join(root, 'record'), 'utf8')).toBe('before');
    expect((await stat(join(root, 'record'))).mode & 0o7777).toBe(0o600);
  });
  it('publishes complete images and preserves ordinary owner/mode through rewrite and undo', async () => {
    const prepared = await prepare();
    const before = await stat(join(root, 'record'));
    expect(
      await rewriteFileIfNoFollow(root, 'record', change, {
        maxBytes: 1024 * 1024,
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).toBe('rewritten');
    expect(await readFile(join(root, 'record'), 'utf8')).toBe('after');
    expect(
      await rewriteFileIfNoFollow(
        root,
        'record',
        (data) => (data.equals(Buffer.from('after')) ? Buffer.from('before') : null),
        { maxBytes: 1024 * 1024, journal: { prepared, index: 0, direction: 'undo' } },
      ),
    ).toBe('rewritten');
    const now = await stat(join(root, 'record'));
    expect([now.uid, now.gid, now.mode & 0o7777]).toEqual([
      before.uid,
      before.gid,
      before.mode & 0o7777,
    ]);
    expect(await readFile(join(root, 'record'), 'utf8')).toBe('before');
  });
  it('removes to a stable park then recreates the complete before image', async () => {
    const prepared = await prepare('before', null);
    expect(
      await removeFileIfNoFollow(root, 'record', (d) => d.equals(Buffer.from('before')), {
        maxBytes: 1024 * 1024,
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).toBe('removed');
    expect(
      (await inspectJournalFilesNoFollow(root, prepared, 1024 * 1024))[0]!.forward.data?.toString(),
    ).toBe('before');
    expect(
      await writeFileNoFollow(root, 'record', 'before', {
        mode: 'create-exclusive',
        journal: { prepared, index: 0, direction: 'undo' },
      }),
    ).toBe('created');
    expect(await readFile(join(root, 'record'), 'utf8')).toBe('before');
  });
  it('never overwrites a public editor entry; retains both original and restoration errors', async () => {
    const prepared = await prepare();
    hooks.afterRename = () => writeFile(join(root, 'record'), 'foreign');
    const error = await rewriteFileIfNoFollow(root, 'record', change, {
      maxBytes: 1024 * 1024,
      journal: { prepared, index: 0, direction: 'forward' },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ParkedFileError);
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors.map((e: NodeJS.ErrnoException) => e.code)).toEqual([
      'EEXIST',
      'EEXIST',
    ]);
    expect(await readFile(join(root, 'record'), 'utf8')).toBe('foreign');
    expect(
      (await inspectJournalFilesNoFollow(root, prepared, 1024 * 1024))[0]!.forward.data?.toString(),
    ).toBe('before');
  });
  it('restores a leaf symlink substituted at the rename without following its target', async () => {
    const prepared = await prepare();
    await writeFile(join(root, 'outside'), 'foreign');
    hooks.beforeRename = async () => {
      await rm(join(root, 'record'));
      await symlink(join(root, 'outside'), join(root, 'record'));
    };
    expect(
      await rewriteFileIfNoFollow(root, 'record', change, {
        maxBytes: 1024 * 1024,
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).toBe('kept');
    expect(await readFile(join(root, 'outside'), 'utf8')).toBe('foreign');
  });
  it('refuses a replaced private directory capability before touching public bytes', async () => {
    const prepared = await prepare();
    await rename(join(root, prepared.rel), join(root, 'saved'));
    await mkdir(join(root, prepared.rel), { mode: 0o700 });
    await expect(
      rewriteFileIfNoFollow(root, 'record', change, {
        maxBytes: 1024 * 1024,
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).rejects.toThrow();
    expect(await readFile(join(root, 'record'), 'utf8')).toBe('before');
  });
  it('refuses a changed prepared image and puts the original inode back', async () => {
    const prepared = await prepare();
    const before = await stat(join(root, 'record'));
    await writeFile(join(root, prepared.rel, '0.after'), 'foreign');
    await expect(
      rewriteFileIfNoFollow(root, 'record', change, {
        maxBytes: 1024 * 1024,
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).rejects.toThrow('image changed');
    expect((await stat(join(root, 'record'))).ino).toBe(before.ino);
    expect(await readFile(join(root, 'record'), 'utf8')).toBe('before');
  });
  it('caps parked editor allocation before reading and restores the editor inode', async () => {
    const prepared = await prepare();
    await writeFile(join(root, 'record'), Buffer.alloc(8 * 1024 * 1024, 120));
    const before = await stat(join(root, 'record'));
    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    expect(
      await rewriteFileIfNoFollow(root, 'record', change, {
        maxBytes: 1024 * 1024,
        journal: { prepared, index: 0, direction: 'forward' },
      }),
    ).toBe('kept');
    expect(alloc.mock.calls.some(([size]) => size > 1024 * 1024)).toBe(false);
    expect((await stat(join(root, 'record'))).ino).toBe(before.ino);
  });
  it('exclusively restores a known park, preserving its mode and refusing a foreign destination', async () => {
    const prepared = await prepare('before', null);
    const op = { prepared, index: 0, direction: 'forward' as const };
    await removeFileIfNoFollow(root, 'record', () => true, { maxBytes: 1024 * 1024, journal: op });
    await chmod(join(root, prepared.rel, '0.forward'), 0o600);
    await restoreJournalFileNoFollow(root, 'record', op);
    expect((await stat(join(root, 'record'))).mode & 0o7777).toBe(0o600);
  });
});
