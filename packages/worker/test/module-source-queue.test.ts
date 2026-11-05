import { expect, it, vi } from 'vitest';
import { QUEUE_NAMES } from '@haive/shared';
import { startModuleControlWorker } from '../src/queues/module-control-queue.js';
import * as sourceQueue from '../src/queues/module-source-queue.js';

const h = vi.hoisted(() => ({
  workers: new Map<
    string,
    { process: (job: unknown) => Promise<unknown>; options: { concurrency: number } }
  >(),
  fetch: vi.fn(),
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Queue: class {},
  Worker: class {
    constructor(
      name: string,
      process: (job: unknown) => Promise<unknown>,
      options: { concurrency: number },
    ) {
      h.workers.set(name, { process, options });
    }
    on() {
      return this;
    }
  },
}));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('../src/modules/source-jobs.js', () => ({
  runModuleSourceFetch: h.fetch,
  recoverModuleSourceFetches: vi.fn(),
}));
it('runs fetches on their own serial worker while teardown remains independently runnable', async () => {
  vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'false');
  try {
    startModuleControlWorker({ loaded: [], entries: [] });
    sourceQueue.startModuleSourceWorker();
    const source = h.workers.get(QUEUE_NAMES.MODULE_SOURCE)!;
    const control = h.workers.get(QUEUE_NAMES.MODULE_CONTROL)!;
    expect(source.options.concurrency).toBe(1);
    let release!: () => void;
    h.fetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const request = {
      name: 'fetch-source',
      data: { sourceId: 'source', requestedAt: '2026-11-05T00:00:00.000Z' },
    };
    const fetching = source.process(request);
    await expect(control.process({ name: 'unsupported', data: {} })).rejects.toThrow(
      'Unknown module-control job',
    );
    expect(h.fetch).toHaveBeenCalledWith({}, 'source', request.data.requestedAt);
    release();
    await fetching;
  } finally {
    vi.unstubAllEnvs();
  }
});
