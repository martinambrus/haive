import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import type { Database } from '@haive/database';
import { CLI_EXEC_JOB_NAMES, ConfigUnavailableError, configService } from '@haive/shared';

const redisStore = {
  get: async () => null,
  set: async () => 'OK',
  del: async () => 1,
};
vi.mock('../../redis.js', () => ({ getRedis: () => redisStore }));
// One task holds a runtime runner, with an invocation of its own queued: the case the gate exists for.
vi.mock('../../sandbox/runtime-admission.js', () => ({
  runnerHoldingTaskIds: async () => new Set(['holder']),
}));
vi.mock('./_shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_shared.js')>()),
  getCliExecQueue: () => ({
    getJobs: async () => [{ name: CLI_EXEC_JOB_NAMES.INVOKE, data: { taskId: 'holder' } }],
  }),
}));

const { enforceRuntimeHolderReserve } = await import('./agent-reserve.js');
const { DEFER_RETRY_WINDOW_MS } = await import('./defer-job.js');
const { log } = await import('./_shared.js');

/** Every select ends in the one row the reserve reads, and the status update takes anything. */
const rows = (value: unknown[]) =>
  Object.assign(Promise.resolve(value), { limit: async () => value });
const db = {
  select: () => ({ from: () => ({ where: () => rows([{ max: 0, voteScore: 0 }]) }) }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
} as unknown as Database;

const payload = { taskId: 't', invocationId: 'inv' } as never;

/** What Redis answers while it replays its dataset after a restart. */
const loading = (): Error =>
  Object.assign(new Error('LOADING Redis is loading the dataset in memory'), {
    name: 'ReplyError',
  });

describe('a defer the store refuses at the reserve gate', () => {
  const moveToDelayed = vi.fn();

  /** Starts the gate under fake timers and settles it after `ms`, as its outcome rather than a throw. */
  async function runFor(ms: number): Promise<unknown> {
    const job = { id: '7', moveToDelayed };
    const settled = enforceRuntimeHolderReserve(db, payload, job as never, 'tok').then(
      () => 'ran',
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.spyOn(log, 'info').mockImplementation(() => undefined);
    moveToDelayed.mockReset();
    moveToDelayed.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('when the switches cannot be read', () => {
    beforeEach(() => {
      vi.spyOn(configService, 'getBoolean').mockRejectedValue(new ConfigUnavailableError('test'));
      vi.spyOn(configService, 'getNumber').mockRejectedValue(new ConfigUnavailableError('test'));
    });

    it('is retried until the store takes it, and the job is held', async () => {
      moveToDelayed.mockRejectedValueOnce(loading()).mockRejectedValueOnce(loading());

      expect(await runFor(5_000)).toBeInstanceOf(DelayedError);
      expect(moveToDelayed).toHaveBeenCalledTimes(3);
    });

    it('lets the job run once the whole window has been refused', async () => {
      moveToDelayed.mockRejectedValue(loading());

      expect(await runFor(DEFER_RETRY_WINDOW_MS + 5_000)).toBe('ran');
      expect(moveToDelayed).toHaveBeenCalledTimes(DEFER_RETRY_WINDOW_MS / 1_000 + 1);
    });
  });

  describe('when the gate decides to yield to a runner holder', () => {
    beforeEach(() => {
      vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
      vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    });

    it('is retried until the store takes it, and the job is held', async () => {
      moveToDelayed.mockRejectedValueOnce(loading()).mockRejectedValueOnce(loading());

      expect(await runFor(5_000)).toBeInstanceOf(DelayedError);
      expect(moveToDelayed).toHaveBeenCalledTimes(3);
    });

    it('lets the job run once the whole window has been refused', async () => {
      moveToDelayed.mockRejectedValue(loading());

      expect(await runFor(DEFER_RETRY_WINDOW_MS + 5_000)).toBe('ran');
      expect(moveToDelayed).toHaveBeenCalledTimes(DEFER_RETRY_WINDOW_MS / 1_000 + 1);
    });

    it('is still deferred when the store refuses the hold marker', async () => {
      const set = vi.spyOn(redisStore, 'set').mockRejectedValueOnce(loading());
      moveToDelayed.mockRejectedValueOnce(loading());

      expect(await runFor(5_000)).toBeInstanceOf(DelayedError);
      expect(set).toHaveBeenCalledTimes(1);
      expect(moveToDelayed).toHaveBeenCalledTimes(2);
    });

    it('holds the job on the first try when the store takes the defer at once', async () => {
      // Control for the two cases above: the yield decision itself is reached, so the extra
      // attempts there come from the refusals and not from a changed rule.
      expect(await runFor(0)).toBeInstanceOf(DelayedError);
      expect(moveToDelayed).toHaveBeenCalledTimes(1);
    });
  });
});
