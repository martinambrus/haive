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

const handlers = await import('./handlers.js');

beforeEach(() => {
  vi.useFakeTimers();
  resolved = 2;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agentPoolCap', () => {
  let cap: typeof import('./agent-pool-cap.js');

  beforeEach(async () => {
    vi.resetModules();
    cap = await import('./agent-pool-cap.js');
  });

  it('reads the pool fresh while nothing has been published', async () => {
    resolved = 5;
    expect(await cap.agentPoolCap()).toBe(5);
    resolved = 6;
    expect(await cap.agentPoolCap()).toBe(6);
  });

  it('returns the published cap until the next publish, then the new one', async () => {
    cap.publishAgentCap(2);
    resolved = 9;
    expect(await cap.agentPoolCap()).toBe(2);
    cap.publishAgentCap(9);
    expect(await cap.agentPoolCap()).toBe(9);
  });
});

describe('startCliExecWorker', () => {
  it('returns the cap the worker published until the next retune, then the new one', async () => {
    await handlers.startCliExecWorker();
    resolved = 9;
    expect(await handlers.agentPoolCap()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await handlers.agentPoolCap()).toBe(9);
  });
});
