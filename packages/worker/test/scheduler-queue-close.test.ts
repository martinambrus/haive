import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ built: 0, closed: 0, failUpsert: false }));

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Worker: class {},
  Queue: class {
    constructor() {
      h.built += 1;
    }
    upsertJobScheduler = async () => {
      if (h.failUpsert) throw new Error('redis down');
    };
    getJobSchedulers = async () => [];
    removeJobScheduler = async () => true;
    close = async () => {
      h.closed += 1;
    };
  },
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  const quiet = { info: () => {}, error: () => {}, debug: () => {}, warn: () => {} };
  return { ...actual, logger: { ...quiet, child: () => quiet } };
});

const { scheduleGlobalKbPurge, scheduleGlobalKbReconcile } =
  await import('../src/queues/global-kb-sync-queue.js');
const { schedulePlanMirrorSweep } = await import('../src/queues/plan-mirror-queue.js');

const SCHEDULERS = { scheduleGlobalKbPurge, scheduleGlobalKbReconcile, schedulePlanMirrorSweep };

beforeEach(() => {
  h.built = 0;
  h.closed = 0;
  h.failUpsert = false;
});

describe.each(Object.entries(SCHEDULERS))('%s', (_name, schedule) => {
  it('closes the queue it builds', async () => {
    await schedule();
    expect(h.built).toBe(1);
    expect(h.closed).toBe(1);
  });

  it('closes the queue when scheduling throws', async () => {
    h.failUpsert = true;
    await expect(schedule()).rejects.toThrow('redis down');
    expect(h.built).toBe(1);
    expect(h.closed).toBe(1);
  });
});
