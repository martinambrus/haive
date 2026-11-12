import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import * as fsSafe from '@haive/shared/fs-safe';
import * as recovery from '../src/repo/bundle-recovery.js';
import { createFakeDb } from '@haive/database/testing';

const getJobs = vi.fn<(types: string[]) => Promise<Array<{ data: unknown }>>>();

vi.mock('bullmq', () => ({
  Queue: class {
    getJobs = getJobs;
  },
}));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));

const { reconcileStrandedSyncingBundles } = await import('../src/data-migrations.js');
const { UNREADABLE_REPLACEMENT_ERROR } = await import('../src/repo/bundle-recovery.js');

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000f1';
const STRANDED = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

function makeFake() {
  return createFakeDb({
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
  });
}
let fake: ReturnType<typeof makeFake>;

function bundle(id: string, over: Record<string, unknown> = {}) {
  fake.insert(schema.customBundles, {
    id,
    userId: USER,
    repositoryId: REPO,
    name: 'kit',
    sourceType: 'git',
    storageRoot: '/bundles/kit',
    status: 'syncing',
    updatedAt: minutesAgo(10),
    ...over,
  });
}
const row = (id: string) => fake.rows(schema.customBundles).find((r) => r.id === id)!;
const run = () => reconcileStrandedSyncingBundles(fake.db as unknown as Database);

beforeEach(() => {
  fake = makeFake();
  getJobs.mockReset().mockResolvedValue([]);
});

describe('reconcileStrandedSyncingBundles', () => {
  it.each(['before extract', 'mid extract', 'between renames', 'after swap', 'previous lost'])(
    'recovers a stranded keep-mode replacement: %s',
    async (point) => {
      const { mkdtemp, readFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { seedCrashedReplacement } = await import('./bundle-replacement-fixture.js');
      const root = await mkdtemp(join(tmpdir(), 'bundle-sweep-'));
      const saved = process.env.BUNDLE_STORAGE_ROOT;
      process.env.BUNDLE_STORAGE_ROOT = root;
      try {
        const fixture = await seedCrashedReplacement(root, fake, point);
        fake.patch(schema.customBundles, fixture.payload.bundleId, {
          lastReplacementNote: 'Replacement failed; the previous bundle remains in use.',
        });
        const items = structuredClone(fake.rows(schema.customBundleItems));
        await run();
        expect(fake.rows(schema.customBundleItems)).toEqual(items);
        const current = fake.rows(schema.customBundles)[0]!;
        if (point === 'previous lost') {
          expect(current).toMatchObject({
            status: 'failed',
            lastReplacementNote: null,
            lastSyncError: expect.stringContaining('previous extracted tree is unavailable'),
          });
        } else {
          expect(current).toMatchObject({ status: 'active', ...fixture.previousArchive });
          await expect(readFile(`${fixture.archivePath}.replacement.json`)).rejects.toThrow();
          expect(await readFile(join(fixture.dest, 'old.md'), 'utf8')).toBe('old tree');
        }
        await run();
        expect(fake.rows(schema.customBundles)[0]).toEqual(current);
      } finally {
        if (saved === undefined) delete process.env.BUNDLE_STORAGE_ROOT;
        else process.env.BUNDLE_STORAGE_ROOT = saved;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['does not parse', 'failed'],
    ['is a directory', 'failed'],
    ['is a symlink', 'failed'],
    ['has a linked parent', 'failed'],
    ['has a non-directory parent', 'failed'],
  ] as const)(
    'a stranded bundle whose record %s ends %s, and the next bundle recovers',
    async (fault, status) => {
      const { mkdir, mkdtemp, readFile, rm, writeFile, symlink } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { seedCrashedReplacement } = await import('./bundle-replacement-fixture.js');
      const root = await mkdtemp(join(tmpdir(), 'bundle-sweep-fault-'));
      const saved = process.env.BUNDLE_STORAGE_ROOT;
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      process.env.BUNDLE_STORAGE_ROOT = root;
      try {
        const dir = join(root, USER, STRANDED);
        const archivePath = join(dir, 'source.new.zip');
        await mkdir(dir, { recursive: true });
        // Refused record leaves are terminal; never follow the link or change its target.
        if (fault === 'is a directory') await mkdir(`${archivePath}.replacement.json`);
        else if (fault === 'is a symlink') {
          const target = join(root, 'outside-record');
          await writeFile(target, 'untouched');
          await symlink(target, `${archivePath}.replacement.json`);
        } else if (fault === 'has a linked parent' || fault === 'has a non-directory parent') {
          await rm(dir, { recursive: true });
          const target = join(root, 'outside-parent');
          if (fault === 'has a linked parent') {
            await mkdir(target);
            await writeFile(join(target, 'source.new.zip.replacement.json'), 'untouched');
            await symlink(target, dir);
          } else await writeFile(dir, 'untouched');
        } else await writeFile(`${archivePath}.replacement.json`, '{invalid json');
        bundle(STRANDED, { sourceType: 'zip', archivePath, lastReplacementNote: 'stale warning' });
        const before = structuredClone(row(STRANDED));
        const fixture = await seedCrashedReplacement(root, fake, 'after swap');
        const items = structuredClone(fake.rows(schema.customBundleItems));

        await expect(run()).resolves.toBeUndefined();

        if (status === 'failed')
          expect(row(STRANDED)).toMatchObject({
            status: 'failed',
            lastReplacementNote: null,
            lastSyncError: UNREADABLE_REPLACEMENT_ERROR,
          });
        else expect(row(STRANDED)).toEqual(before);
        expect(row(fixture.payload.bundleId)).toMatchObject({
          status: 'active',
          ...fixture.previousArchive,
        });
        expect(await readFile(join(fixture.dest, 'old.md'), 'utf8')).toBe('old tree');
        expect(fake.rows(schema.customBundleItems)).toEqual(items);
        if (fault === 'has a linked parent')
          expect(
            await readFile(join(root, 'outside-parent', 'source.new.zip.replacement.json'), 'utf8'),
          ).toBe('untouched');
        if (fault === 'has a non-directory parent')
          expect(await readFile(dir, 'utf8')).toBe('untouched');
        if (fault === 'is a symlink')
          expect(await readFile(join(root, 'outside-record'), 'utf8')).toBe('untouched');
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ bundleId: STRANDED, err: expect.any(Error) }),
          expect.any(String),
        );
      } finally {
        warn.mockRestore();
        if (saved === undefined) delete process.env.BUNDLE_STORAGE_ROOT;
        else process.env.BUNDLE_STORAGE_ROOT = saved;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['outside transactions', 'racing sweeps', 'crash before settlement', 'new generation'])(
    'recovers through short phases: %s',
    async (scenario) => {
      const { mkdtemp, readFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { seedCrashedReplacement } = await import('./bundle-replacement-fixture.js');
      const root = await mkdtemp(join(tmpdir(), 'bundle-phases-'));
      const saved = process.env.BUNDLE_STORAGE_ROOT;
      process.env.BUNDLE_STORAGE_ROOT = root;
      const fixture = await seedCrashedReplacement(root, fake, 'after swap');
      const originalStamp = row(fixture.payload.bundleId).updatedAt;
      const transaction = fake.db.transaction.bind(fake.db);
      let depth = 0;
      const tx = vi.spyOn(fake.db, 'transaction').mockImplementation(async (fn) => {
        depth++;
        try {
          return await transaction(fn);
        } finally {
          depth--;
        }
      });
      const readOriginal = recovery.readReplacement;
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = vi.spyOn(recovery, 'readReplacement').mockImplementation(async (...args) => {
        if (scenario === 'outside transactions') expect(depth).toBe(0);
        if (scenario === 'racing sweeps') {
          entered();
          await gate;
        }
        return readOriginal(...args);
      });
      const treeOriginal = fsSafe.renameNoFollow;
      const tree = vi.spyOn(fsSafe, 'renameNoFollow').mockImplementation(async (...args) => {
        if (scenario === 'outside transactions') expect(depth).toBe(0);
        const restored = await treeOriginal(...args);
        if (scenario === 'new generation')
          fake.patch(schema.customBundles, fixture.payload.bundleId, {
            status: 'active',
            archivePath: 'newer-source.zip',
            updatedAt: new Date(),
          });
        return restored;
      });
      try {
        if (scenario === 'crash before settlement') {
          let writes = 0;
          fake.hooks.beforeUpdate = async () => {
            if (++writes === 2) throw new Error('process died before settlement');
          };
          await run();
          fake.hooks.beforeUpdate = null;
          expect(row(fixture.payload.bundleId).status).toBe('syncing');
          expect(row(fixture.payload.bundleId).updatedAt).not.toEqual(originalStamp);
          expect(await readFile(join(fixture.dest, 'old.md'), 'utf8')).toBe('old tree');
          fake.patch(schema.customBundles, fixture.payload.bundleId, { updatedAt: minutesAgo(10) });
          await run();
        } else if (scenario === 'racing sweeps') {
          const first = run();
          await reached;
          const second = run();
          // Both passes have had a chance to observe the candidate. Only the owner reads disk.
          await new Promise((resolve) => setTimeout(resolve, 30));
          const reads = read.mock.calls.length;
          release();
          await Promise.all([first, second]);
          expect(reads).toBe(1);
        } else await run();
        expect(row(fixture.payload.bundleId)).toMatchObject(
          scenario === 'new generation'
            ? { status: 'active', archivePath: 'newer-source.zip' }
            : { status: 'active', ...fixture.previousArchive },
        );
        await run();
        expect(await readFile(join(fixture.dest, 'old.md'), 'utf8')).toBe('old tree');
      } finally {
        release();
        tx.mockRestore();
        read.mockRestore();
        tree.mockRestore();
        fake.hooks.beforeUpdate = null;
        if (saved === undefined) delete process.env.BUNDLE_STORAGE_ROOT;
        else process.env.BUNDLE_STORAGE_ROOT = saved;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['EACCES', 'EMFILE', 'ENFILE'])(
    'retries a transient record read failure: %s',
    async (code) => {
      bundle(STRANDED, {
        sourceType: 'zip',
        archivePath: '/var/lib/haive/bundles/' + USER + '/' + STRANDED + '/source.new.zip',
      });
      const read = vi
        .spyOn(recovery, 'readReplacement')
        .mockRejectedValueOnce(Object.assign(new Error('read failed'), { code }));
      try {
        await run();
        expect(row(STRANDED).status).toBe('syncing');
      } finally {
        read.mockRestore();
      }
    },
  );

  it('fails a bundle that has been syncing for minutes with no job in the queue', async () => {
    bundle(STRANDED, {
      lastReplacementNote: 'Replacement failed; the previous bundle remains in use.',
    });
    getJobs.mockResolvedValue([{ data: { bundleId: OTHER } }]);

    await run();

    expect(row(STRANDED).status).toBe('failed');
    expect(row(STRANDED).lastReplacementNote).toBeNull();
    expect(String(row(STRANDED).lastSyncError)).not.toBe('');
  });

  it('leaves a bundle alone while a job for it is still live', async () => {
    bundle(STRANDED);
    getJobs.mockResolvedValue([{ data: { bundleId: STRANDED } }]);

    await run();

    expect(row(STRANDED).status).toBe('syncing');
  });

  it('fails the stranded bundle and keeps the one whose job is live', async () => {
    bundle(STRANDED);
    bundle(OTHER);
    getJobs.mockResolvedValue([{ data: { bundleId: OTHER } }]);

    await run();

    expect(row(STRANDED).status).toBe('failed');
    expect(row(OTHER).status).toBe('syncing');
  });

  it('counts a job in any state that still owes a run as live', async () => {
    bundle(STRANDED);

    await run();

    const asked = getJobs.mock.calls[0]![0];
    expect([...asked].sort()).toEqual(
      ['active', 'delayed', 'prioritized', 'waiting', 'waiting-children'].sort(),
    );
  });

  it('is not protected by a job that names no bundle', async () => {
    bundle(STRANDED);
    getJobs.mockResolvedValue([{ data: {} }]);

    await run();

    expect(row(STRANDED).status).toBe('failed');
  });

  it('leaves a recent bundle alone without reading the queue', async () => {
    bundle(STRANDED, { updatedAt: minutesAgo(1) });

    await run();

    expect(row(STRANDED).status).toBe('syncing');
    expect(getJobs).not.toHaveBeenCalled();
  });

  it('leaves a bundle alone that is not syncing, without reading the queue', async () => {
    bundle(STRANDED, { status: 'active' });
    bundle(OTHER, { status: 'failed', lastSyncError: 'earlier failure' });

    await run();

    expect(row(STRANDED).status).toBe('active');
    expect(row(OTHER).lastSyncError).toBe('earlier failure');
    expect(getJobs).not.toHaveBeenCalled();
  });

  it('leaves a bundle alone whose updated_at moved between the read and the update', async () => {
    bundle(STRANDED);
    getJobs.mockImplementation(async () => {
      fake.patch(schema.customBundles, STRANDED, { updatedAt: new Date() });
      return [];
    });

    await run();

    expect(row(STRANDED).status).toBe('syncing');
  });

  it('leaves a bundle alone that finished between the read and the update', async () => {
    bundle(STRANDED);
    getJobs.mockImplementation(async () => {
      fake.patch(schema.customBundles, STRANDED, { status: 'active', lastSyncError: null });
      return [];
    });

    await run();

    expect(row(STRANDED).status).toBe('active');
  });

  it('labels candidate counts as attempts when a candidate changes before recovery', async () => {
    bundle(STRANDED);
    bundle(OTHER);
    getJobs.mockImplementation(async () => {
      fake.patch(schema.customBundles, STRANDED, { updatedAt: new Date() });
      return [];
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      await run();
      expect(row(STRANDED).status).toBe('syncing');
      expect(row(OTHER).status).toBe('failed');
      expect(warn).toHaveBeenCalledWith(
        { attempted: 2 },
        'attempted recovery of bundles stranded at syncing',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('writes nothing when the queue cannot be read', async () => {
    bundle(STRANDED);
    getJobs.mockRejectedValue(new Error('redis is down'));

    await expect(run()).rejects.toThrow('redis is down');

    expect(row(STRANDED).status).toBe('syncing');
  });
});
