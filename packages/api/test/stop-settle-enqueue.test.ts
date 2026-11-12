import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({
  added: [] as unknown[][],
  impl: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock('../src/queues.js', () => ({
  getTaskQueue: () => ({
    add: async (...args: unknown[]) => {
      queue.added.push(args);
      return queue.impl ? queue.impl(...args) : undefined;
    },
  }),
}));

import { TASK_JOB_NAMES } from '@haive/shared';
import * as cancelTask from '../src/lib/cancel-task.js';

const JOB = 'settle-stopped-task';
const FAILED_AT = '2026-11-01T10:20:30.456Z';

/** Resolved at call time, so a missing export fails the case with a message, not the whole file. */
const enqueueStopSettle = (
  taskId: string,
  userId: string,
  failedAt: string | null,
): Promise<void> => {
  const fn = (cancelTask as Record<string, unknown>).enqueueStopSettle;
  if (typeof fn !== 'function') {
    throw new Error('enqueueStopSettle is not exported from src/lib/cancel-task.ts');
  }
  return (fn as (t: string, u: string, f: string | null) => Promise<void>)(
    taskId,
    userId,
    failedAt,
  );
};

describe('enqueueStopSettle', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);

  beforeEach(() => {
    vi.useFakeTimers();
    queue.added = [];
    queue.impl = null;
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    vi.useRealTimers();
    process.off('unhandledRejection', onUnhandled);
  });

  it('A0: names the job settle-stopped-task, apart from every other task job name', () => {
    const names = TASK_JOB_NAMES as Record<string, string>;
    expect(names.SETTLE_STOPPED).toBe(JOB);
    const values = Object.values(names);
    expect(new Set(values).size).toBe(values.length);
  });

  it('A1: queues one job with the exact name and payload', async () => {
    await expect(enqueueStopSettle('t1', 'u1', FAILED_AT)).resolves.toBeUndefined();
    expect(queue.added).toHaveLength(1);
    const [name, payload] = queue.added[0]!;
    expect(name).toBe(JOB);
    expect(payload).toEqual({ taskId: 't1', userId: 'u1', failedAt: FAILED_AT });
  });

  it('A2: queues nothing when the Stop failed no task (failedAt null)', async () => {
    await expect(enqueueStopSettle('t1', 'u1', null)).resolves.toBeUndefined();
    expect(queue.added).toHaveLength(0);
  });

  it('A3: answers normally when the queue refuses, with no unhandled rejection', async () => {
    queue.impl = async () => {
      throw new Error('redis down');
    };
    await expect(enqueueStopSettle('t1', 'u1', FAILED_AT)).resolves.toBeUndefined();
    expect(queue.added).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(unhandled).toEqual([]);
  });

  it('A4: gives up on a queue that never answers within seconds, and a later rejection is handled', async () => {
    let rejectLate: (err: Error) => void = () => undefined;
    queue.impl = () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    const pending = enqueueStopSettle('t1', 'u1', FAILED_AT).then(() => 'resolved');
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await pending;
    expect(outcome, 'enqueueStopSettle against an add that never settles').toBe('resolved');
    expect(queue.added).toHaveLength(1);

    rejectLate(new Error('redis came back too late'));
    await vi.advanceTimersByTimeAsync(100);
    expect(unhandled).toEqual([]);
  }, 15_000);

  it('A5: deduplicates the same failure while live, with finite retention and retries', async () => {
    await enqueueStopSettle('t1', 'u1', FAILED_AT);
    expect(queue.added).toHaveLength(1);
    const opts = queue.added[0]![2] as Record<string, unknown> | undefined;
    expect(opts, 'the options the job is queued with').toBeDefined();
    expect(opts).not.toHaveProperty('jobId');
    expect(opts).toHaveProperty('deduplication', { id: `stop-settle-t1-${Date.parse(FAILED_AT)}` });
    expect(typeof opts!.removeOnComplete).toBe('number');
    expect(Number.isFinite(opts!.removeOnComplete)).toBe(true);
    expect(typeof opts!.removeOnFail).toBe('number');
    expect(Number.isFinite(opts!.removeOnFail)).toBe(true);
    expect(typeof opts!.attempts).toBe('number');
    expect(opts!.attempts as number).toBeGreaterThanOrEqual(2);
  });
});
