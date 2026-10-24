import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  processor: undefined as unknown as (job: { name: string; data: unknown }) => Promise<unknown>,
  read: vi.fn(),
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Queue: class {},
  Worker: class {
    constructor(_name: string, processor: typeof h.processor) {
      h.processor = processor;
    }
    on() {}
  },
}));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('../src/db.js', () => ({
  getDb: () => ({ query: { repositories: { findFirst: h.read } } }),
}));

import { PLAN_MIRROR_JOB_NAMES } from '@haive/shared';
import { startPlanMirrorWorker } from '../src/queues/plan-mirror-queue.js';
import { processModuleControlJob } from '../src/queues/module-control-queue.js';

it.each([PLAN_MIRROR_JOB_NAMES.SAVE, PLAN_MIRROR_JOB_NAMES.PULL])(
  'sanitizes %s before BullMQ flattens a DB failure',
  async (name) => {
    h.read.mockClear();
    const secret = randomBytes(24).toString('base64url');
    h.read.mockRejectedValueOnce(
      new DrizzleQueryError(
        'select * from repositories where id = $1',
        [secret],
        new Error(secret),
      ),
    );
    startPlanMirrorWorker();
    const err = await h
      .processor({ name, data: { repositoryId: 'repo', userId: 'user' } })
      .catch((err: unknown) => err);
    expect(err instanceof Error).toBe(true);
    const text = JSON.stringify({ message: (err as Error).message, stack: (err as Error).stack });
    expect(
      Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
        text.includes(part),
      ),
    ).toBe(false);
    expect(h.read).toHaveBeenCalledOnce();
  },
);

it('sanitizes a module teardown DB failure before it crosses the queue', async () => {
  const secret = randomBytes(24).toString('base64url');
  const db = {
    select: vi.fn(() => {
      throw new DrizzleQueryError('select $1', [secret], new Error(secret));
    }),
  };
  const err = await processModuleControlJob(
    {
      db: db as never,
      loaded: [{ manifest: { id: 'alpha' } }] as never,
      entries: [],
      jobsStarted: () => false,
      teardownRunning: () => false,
    },
    { name: 'teardown', data: { moduleId: 'alpha' } },
  ).catch((err: unknown) => err);
  expect(err instanceof Error).toBe(true);
  expect(db.select).toHaveBeenCalledOnce();
  const text = JSON.stringify({ message: (err as Error).message, stack: (err as Error).stack });
  expect(
    Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
      text.includes(part),
    ),
  ).toBe(false);
});
