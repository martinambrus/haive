import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplyError } from 'ioredis';
import { logger } from '../src/logger/index.js';
import { ConfigUnavailableError, retryWhileConfigUnavailable } from '../src/config/index.js';

afterEach(() => vi.restoreAllMocks());

const setup = () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { warn, sleeps, sleep };
};

const failing = (times: number, error: () => Error) => {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    if (calls <= times) throw error();
    return 'ok';
  });
};

describe('retryWhileConfigUnavailable', () => {
  it('returns the first success with no log and no sleep', async () => {
    const { warn, sleeps, sleep } = setup();
    await expect(retryWhileConfigUnavailable('t', async () => 42, { sleep })).resolves.toBe(42);
    expect(sleeps).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retries the typed outage with a capped backoff and logs each retry', async () => {
    const { warn, sleeps, sleep } = setup();
    const run = failing(6, () => new ConfigUnavailableError('get'));
    await expect(retryWhileConfigUnavailable('boot', run, { sleep })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(7);
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    expect(warn).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      {
        what: 'boot',
        attempt: 1,
        waitedMs: expect.any(Number),
        delayMs: 500,
        err: expect.any(ConfigUnavailableError),
      },
      expect.any(String),
    );
    expect(warn).toHaveBeenNthCalledWith(
      6,
      {
        what: 'boot',
        attempt: 6,
        waitedMs: expect.any(Number),
        delayMs: 5000,
        err: expect.any(ConfigUnavailableError),
      },
      expect.any(String),
    );
  });

  it.each([
    ['a plain Error', () => new Error('boom')],
    ['a ReplyError', () => new ReplyError('WRONGPASS invalid username-password pair')],
    [
      'a look-alike by name',
      () =>
        new (class X extends Error {
          override name = 'ConfigUnavailableError';
        })('lookalike'),
    ],
  ])('rethrows %s at once', async (_label, make) => {
    const { warn, sleeps, sleep } = setup();
    const err = make();
    await expect(
      retryWhileConfigUnavailable(
        't',
        async () => {
          throw err;
        },
        { sleep },
      ),
    ).rejects.toBe(err);
    expect(sleeps).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('honours custom initial and max delays', async () => {
    const { sleeps, sleep } = setup();
    const run = failing(4, () => new ConfigUnavailableError('get'));
    await retryWhileConfigUnavailable('t', run, { initialDelayMs: 10, maxDelayMs: 30, sleep });
    expect(sleeps).toEqual([10, 20, 30, 30]);
  });
});
