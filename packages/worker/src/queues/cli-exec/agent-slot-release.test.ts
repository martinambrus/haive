import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import { CLI_EXEC_JOB_NAMES } from '@haive/shared';

const pool = new Map<string, string>();
const fakeRedis = {
  hset: async (_k: string, f: string, v: string) => void pool.set(f, v),
  hdel: async (_k: string, ...fields: string[]) => void fields.forEach((f) => pool.delete(f)),
  eval: async (_script: string, _n: number, _k: string, ...a: (string | number)[]) => {
    const [now, expiry, , cap] = a.map(Number) as [number, number, number, number];
    const field = String(a[2]);
    let live = 0;
    for (const [f, v] of [...pool]) {
      if (Number(v) > now) live += 1;
      else pool.delete(f);
    }
    if (!pool.has(field) && live >= cap) return [0, live];
    pool.set(field, String(expiry));
    return [1, live];
  },
};

let processor!: (job: unknown, token?: string) => Promise<unknown>;
const findInvocation = vi.fn();
const holderReserve = vi.fn();

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Worker: class {
    constructor(_queue: string, fn: typeof processor) {
      processor = fn;
    }
    on() {}
  },
}));
vi.mock('../../redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../redis.js')>()),
  getRedis: () => fakeRedis,
  getBullRedis: () => ({}),
}));
vi.mock('../../db.js', () => ({
  getDb: () => ({
    query: { cliInvocations: { findFirst: findInvocation } },
    select: () => ({ from: () => ({ where: async () => [{ n: 0 }] }) }),
  }),
}));
vi.mock('../../orchestrator/pause.js', () => ({ resolvePause: async () => false }));
vi.mock('../../sandbox/runtime-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sandbox/runtime-admission.js')>()),
  resolveAgentConcurrency: async () => 2,
}));
vi.mock('./agent-reserve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-reserve.js')>()),
  enforceRuntimeHolderReserve: holderReserve,
}));

const { startCliExecWorker } = await import('./handlers.js');

const invokeJob = {
  name: CLI_EXEC_JOB_NAMES.INVOKE,
  id: '7',
  data: { taskId: 't', invocationId: 'inv-7' },
  moveToDelayed: vi.fn(async () => undefined),
};
const invokeFields = () => [...pool.keys()].filter((f) => f.startsWith('invoke:'));

beforeEach(async () => {
  pool.clear();
  findInvocation.mockReset();
  holderReserve.mockReset();
  await startCliExecWorker();
});

describe('the INVOKE slot is held for the whole processor run', () => {
  it('holds it while handleCliExecJob runs and frees it on a normal return', async () => {
    findInvocation.mockImplementation(async () => {
      expect(invokeFields()).toEqual(['invoke:7:tok']);
      return undefined;
    });
    await processor(invokeJob, 'tok');
    expect(findInvocation).toHaveBeenCalledTimes(1);
    expect(invokeFields()).toEqual([]);
  });

  it('frees it when handleCliExecJob throws', async () => {
    findInvocation.mockRejectedValue(new Error('db down'));
    await expect(processor(invokeJob, 'tok')).rejects.toThrow('db down');
    expect(invokeFields()).toEqual([]);
  });

  it('frees it when a later gate defers the job', async () => {
    holderReserve.mockRejectedValue(new DelayedError());
    await expect(processor(invokeJob, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(findInvocation).not.toHaveBeenCalled();
    expect(invokeFields()).toEqual([]);
  });

  it('holds no slot for a job the lane gate defers', async () => {
    pool.set('lease:a', String(Date.now() + 60_000));
    pool.set('lease:b', String(Date.now() + 60_000));
    await expect(processor(invokeJob, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(findInvocation).not.toHaveBeenCalled();
    expect(invokeFields()).toEqual([]);
  });
});
