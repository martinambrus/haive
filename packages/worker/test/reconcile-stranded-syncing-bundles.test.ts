import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { createFakeDb } from '@haive/database/testing';

const getJobs = vi.fn<(types: string[]) => Promise<Array<{ data: unknown }>>>();

vi.mock('bullmq', () => ({
  Queue: class {
    getJobs = getJobs;
  },
}));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));

const { reconcileStrandedSyncingBundles } = await import('../src/data-migrations.js');

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

  it('fails a stranded bundle whose record does not parse and recovers the next bundle', async () => {
    const { mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
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
      const corruptRecord = '{invalid json';
      await writeFile(`${archivePath}.replacement.json`, corruptRecord);
      bundle(STRANDED, { sourceType: 'zip', archivePath });
      const fixture = await seedCrashedReplacement(root, fake, 'after swap');
      const items = structuredClone(fake.rows(schema.customBundleItems));

      await expect(run()).resolves.toBeUndefined();

      expect(row(STRANDED)).toMatchObject({ status: 'failed', lastReplacementNote: null });
      expect(row(fixture.payload.bundleId)).toMatchObject({
        status: 'active',
        ...fixture.previousArchive,
      });
      expect(await readFile(join(fixture.dest, 'old.md'), 'utf8')).toBe('old tree');
      expect(fake.rows(schema.customBundleItems)).toEqual(items);
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
  });

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

  it('writes nothing when the queue cannot be read', async () => {
    bundle(STRANDED);
    getJobs.mockRejectedValue(new Error('redis is down'));

    await expect(run()).rejects.toThrow('redis is down');

    expect(row(STRANDED).status).toBe('syncing');
  });
});
