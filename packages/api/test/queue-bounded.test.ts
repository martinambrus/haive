import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/context.js';
import {
  QUEUE_ADD_WAIT_MS,
  QueueUnavailableError,
  addBestEffort,
  addOrRefuse,
  boundedAdd,
} from '../src/lib/queue-bounded.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => undefined);

describe('queue-bounded', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('waits 2000 ms by default', () => {
    expect(QUEUE_ADD_WAIT_MS).toBe(2000);
  });

  it('boundedAdd resolves with the add value', async () => {
    await expect(boundedAdd(async () => 'job')).resolves.toBe('job');
  });

  it('boundedAdd rejects after waitMs when the add never settles', async () => {
    const started = Date.now();
    await expect(boundedAdd(never, 30)).rejects.toThrow('redis did not answer in time');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('boundedAdd rejects with the add own rejection', async () => {
    await expect(
      boundedAdd(async () => {
        throw new Error('redis down');
      }),
    ).rejects.toThrow('redis down');
  });

  it('a later rejection of a timed-out add raises no unhandled rejection', async () => {
    let rejectLate: (err: Error) => void = () => undefined;
    const add = () =>
      new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });
    await expect(boundedAdd(add, 20)).rejects.toThrow();
    rejectLate(new Error('too late'));
    await sleep(50);
    expect(unhandled).toEqual([]);
  });

  it('addBestEffort returns true on success and false on failure, never throwing', async () => {
    await expect(addBestEffort(async () => 1, 'msg')).resolves.toBe(true);
    await expect(
      addBestEffort(
        async () => {
          throw new Error('x');
        },
        'msg',
        { taskId: 't' },
      ),
    ).resolves.toBe(false);
    await expect(addBestEffort(never, 'msg', undefined, 20)).resolves.toBe(false);
  });

  it('addBestEffort and addOrRefuse handle a synchronous throw from the factory', async () => {
    const boom = (): Promise<never> => {
      throw new Error('no queue');
    };
    await expect(addBestEffort(boom, 'msg')).resolves.toBe(false);
    await expect(addOrRefuse(boom, 'thing')).rejects.toBeInstanceOf(QueueUnavailableError);
  });

  it('addOrRefuse passes the value through on success', async () => {
    await expect(addOrRefuse(async () => 7, 'thing')).resolves.toBe(7);
  });

  it('addOrRefuse throws a 503 queue_unavailable that does not carry the cause', async () => {
    const err = await addOrRefuse(
      async () => {
        throw new Error('ECONNREFUSED 10.0.0.9:6379');
      },
      'thing',
      { taskId: 't' },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueUnavailableError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 503, code: 'queue_unavailable' });
    expect((err as Error).message).not.toContain('ECONNREFUSED');
    await expect(addOrRefuse(never, 'thing', undefined, 20)).rejects.toMatchObject({
      status: 503,
    });
  });
});
