import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
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
  return createFakeDb({ customBundles: schema.customBundles });
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
  it('fails a bundle that has been syncing for minutes with no job in the queue', async () => {
    bundle(STRANDED);
    getJobs.mockResolvedValue([{ data: { bundleId: OTHER } }]);

    await run();

    expect(row(STRANDED).status).toBe('failed');
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
