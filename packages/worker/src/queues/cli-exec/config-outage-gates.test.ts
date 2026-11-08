import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import {
  CLI_EXEC_JOB_NAMES,
  CONFIG_KEYS,
  ConfigUnavailableError,
  configService,
} from '@haive/shared';

/** What the agent pool script answers: a free slot, or (`poolFull`) a pool with no room. */
let poolFull = false;
/** How many agents the task already runs, as the per-task cap counts them. */
let runningAgents = 0;
const fakeRedis = {
  hset: async () => 1,
  hdel: async () => 1,
  eval: async () => (poolFull ? [0, 99] : [1, 0]),
};

let processor!: (job: unknown, token?: string) => Promise<unknown>;
const findInvocation = vi.fn();

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
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([{ n: runningAgents }]), {
            limit: async () => [{ pausedAt: null }],
          }),
      }),
    }),
  }),
}));
vi.mock('../../sandbox/runtime-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sandbox/runtime-admission.js')>()),
  resolveAgentConcurrency: async () => 2,
}));

const { startCliExecWorker } = await import('./handlers.js');
const { DEFER_RETRY_WINDOW_MS } = await import('./defer-job.js');

const cue = (): ConfigUnavailableError => new ConfigUnavailableError('test');
const plain = (): Error => new Error('ConfigService not initialized');

const moveToDelayed = vi.fn(async () => undefined);
const job = () => ({
  name: CLI_EXEC_JOB_NAMES.INVOKE,
  id: '7',
  data: { taskId: 't', invocationId: 'inv-7' },
  moveToDelayed,
});

/** Every config read answers like an uninitialised store, except the one key under test. */
function readsFail(key: string, kind: 'getBoolean' | 'getNumber', err: Error): void {
  vi.spyOn(configService, 'getBoolean').mockImplementation(async (k: string) => {
    if (kind === 'getBoolean' && k === key) throw err;
    if (k === CONFIG_KEYS.GLOBAL_PAUSE) return false;
    throw plain();
  });
  vi.spyOn(configService, 'getNumber').mockImplementation(async (k: string) => {
    if (kind === 'getNumber' && k === key) throw err;
    throw plain();
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  findInvocation.mockReset();
  moveToDelayed.mockReset();
  moveToDelayed.mockResolvedValue(undefined);
  poolFull = false;
  runningAgents = 0;
  readsFail('', 'getBoolean', plain());
  await startCliExecWorker();
});

describe('an unreadable config store holds a cli invocation instead of admitting it', () => {
  it('defers the job when the global pause switch cannot be read', async () => {
    readsFail(CONFIG_KEYS.GLOBAL_PAUSE, 'getBoolean', cue());
    await expect(processor(job(), 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(findInvocation).not.toHaveBeenCalled();
  });

  it('defers the job when the per-task agent cap cannot be read', async () => {
    readsFail(CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK, 'getNumber', cue());
    await expect(processor(job(), 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(findInvocation).not.toHaveBeenCalled();
  });

  it('still runs the job when the pause switch read fails for any other reason', async () => {
    readsFail(CONFIG_KEYS.GLOBAL_PAUSE, 'getBoolean', plain());
    await processor(job(), 'tok');
    expect(findInvocation).toHaveBeenCalledTimes(1);
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it('still runs the job when the cap read fails for any other reason', async () => {
    readsFail(CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK, 'getNumber', plain());
    await processor(job(), 'tok');
    expect(findInvocation).toHaveBeenCalledTimes(1);
    expect(moveToDelayed).not.toHaveBeenCalled();
  });
});

describe('a defer the store refuses is retried before the job is let through', () => {
  /** What Redis answers while it replays its dataset after a restart. */
  const loading = (): Error =>
    Object.assign(new Error('LOADING Redis is loading the dataset in memory'), {
      name: 'ReplyError',
    });

  const refuseDefers = (times: number): void => {
    for (let i = 0; i < times; i++) moveToDelayed.mockRejectedValueOnce(loading());
  };

  /** Starts the job under fake timers and settles it after `ms`, as the outcome rather than a throw. */
  async function runFor(ms: number): Promise<unknown> {
    const settled = processor(job(), 'tok').then(
      () => 'ran',
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the job when the per-task cap cannot be read', async () => {
    readsFail(CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK, 'getNumber', cue());
    refuseDefers(2);

    expect(await runFor(5_000)).toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(3);
    expect(findInvocation).not.toHaveBeenCalled();
  });

  it('holds the job when the pause switch cannot be read', async () => {
    readsFail(CONFIG_KEYS.GLOBAL_PAUSE, 'getBoolean', cue());
    refuseDefers(2);

    expect(await runFor(5_000)).toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(3);
    expect(findInvocation).not.toHaveBeenCalled();
  });

  it('holds the job when its task is at the per-task cap', async () => {
    vi.spyOn(configService, 'getNumber').mockImplementation(async (k: string) => {
      if (k === CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK) return 1;
      throw plain();
    });
    runningAgents = 1;
    refuseDefers(2);

    expect(await runFor(5_000)).toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(3);
    expect(findInvocation).not.toHaveBeenCalled();
  });

  it('holds the job when the agent pool is full', async () => {
    poolFull = true;
    refuseDefers(2);

    expect(await runFor(5_000)).toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(3);
    expect(findInvocation).not.toHaveBeenCalled();
  });

  it('lets the job run once the store has refused the defer for the whole window', async () => {
    readsFail(CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK, 'getNumber', cue());
    moveToDelayed.mockRejectedValue(loading());

    expect(await runFor(DEFER_RETRY_WINDOW_MS + 5_000)).toBe('ran');
    expect(moveToDelayed).toHaveBeenCalledTimes(DEFER_RETRY_WINDOW_MS / 1_000 + 1);
    expect(findInvocation).toHaveBeenCalledTimes(1);
  });
});
