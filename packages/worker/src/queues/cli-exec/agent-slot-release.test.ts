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
const pauseCheck = vi.fn(async (_taskId: string): Promise<boolean> => false);
vi.mock('../../orchestrator/pause.js', () => ({
  resolvePause: (_db: unknown, taskId: string) => pauseCheck(taskId),
}));
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
  pauseCheck.mockReset();
  pauseCheck.mockImplementation(async () => false);
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

describe('slots go in activation order', () => {
  it('gives the last slot to the job activated first, however long its pause check takes', async () => {
    pool.set('lease:a', String(Date.now() + 60_000));
    let unblock!: (paused: boolean) => void;
    pauseCheck.mockImplementation((taskId: string) =>
      taskId === 'first' ? new Promise<boolean>((r) => (unblock = r)) : Promise.resolve(false),
    );
    const job = (id: string, taskId: string) => ({
      ...invokeJob,
      id,
      data: { taskId, invocationId: `inv-${id}` },
      moveToDelayed: vi.fn(async () => undefined),
    });
    const first = processor(job('1', 'first'), 'tok');
    const second = processor(job('2', 'second'), 'tok');
    await expect(second).rejects.toBeInstanceOf(DelayedError);
    await vi.waitFor(() => expect(pauseCheck).toHaveBeenCalledWith('first'));
    unblock(false);
    await first;
    expect(findInvocation).toHaveBeenCalledTimes(1);
    expect(invokeFields()).toEqual([]);
  });

  it('frees the slot of a job its pause gate defers', async () => {
    pauseCheck.mockImplementation(async () => true);
    await expect(processor(invokeJob, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(invokeFields()).toEqual([]);
  });
});

describe('a refused job waits briefly for a slot a turned-away holder frees', () => {
  it('takes the slot a paused job releases instead of deferring', async () => {
    pool.set('lease:a', String(Date.now() + 60_000));
    let unblock!: (paused: boolean) => void;
    pauseCheck.mockImplementation((taskId: string) =>
      taskId === 'paused' ? new Promise<boolean>((r) => (unblock = r)) : Promise.resolve(false),
    );
    const job = (id: string, taskId: string) => ({
      ...invokeJob,
      id,
      data: { taskId, invocationId: `inv-${id}` },
      moveToDelayed: vi.fn(async () => undefined),
    });
    const paused = processor(job('1', 'paused'), 'tok');
    const live = job('2', 'live');
    const running = processor(live, 'tok');
    await vi.waitFor(() => expect(pauseCheck).toHaveBeenCalledWith('paused'));
    unblock(true);
    await expect(paused).rejects.toBeInstanceOf(DelayedError);
    await running;
    expect(live.moveToDelayed).not.toHaveBeenCalled();
    expect(findInvocation).toHaveBeenCalledTimes(1);
  });

  it('still defers when the pool stays full past the retry window', async () => {
    pool.set('lease:a', String(Date.now() + 60_000));
    pool.set('lease:b', String(Date.now() + 60_000));
    const job = { ...invokeJob, moveToDelayed: vi.fn(async () => undefined) };
    const started = Date.now();
    await expect(processor(job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
  });
});
