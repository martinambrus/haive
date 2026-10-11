import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let resolved = 2;

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Worker: class {
    concurrency = 0;
    on() {}
  },
}));
vi.mock('../../redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../redis.js')>()),
  getRedis: () => ({}),
  getBullRedis: () => ({}),
}));
vi.mock('../../db.js', () => ({ getDb: () => ({}) }));
vi.mock('../../sandbox/runtime-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sandbox/runtime-admission.js')>()),
  resolveAgentConcurrency: async () => resolved,
}));

type Handlers = typeof import('./handlers.js');
let handlers: Handlers;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  resolved = 2;
  handlers = await import('./handlers.js');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agentPoolCap', () => {
  it('reads the pool fresh while nothing has been published', async () => {
    resolved = 5;
    expect(await handlers.agentPoolCap()).toBe(5);
    resolved = 6;
    expect(await handlers.agentPoolCap()).toBe(6);
  });

  it('returns the cap the worker published until the next retune, then the new one', async () => {
    await handlers.startCliExecWorker();
    resolved = 9;
    expect(await handlers.agentPoolCap()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await handlers.agentPoolCap()).toBe(9);
  });
});
