import { DelayedError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { TASK_JOB_NAMES } from '@haive/shared';
import { getDb } from '../src/db.js';
import { holdStepAdvance, processTaskJob } from '../src/queues/task-queue.js';

vi.mock('../src/db.js', () => ({
  getDb: vi.fn(() => {
    throw new Error('no database in this test');
  }),
}));

let nextId = 1;
function advance(data: Record<string, unknown>, name: string = TASK_JOB_NAMES.ADVANCE_STEP) {
  const moveToDelayed = vi.fn(async (_until: number, _token?: string) => undefined);
  const job = { id: String(nextId++), name, data, timestamp: Date.now(), moveToDelayed };
  return { job: job as unknown as Job, moveToDelayed };
}

describe('holdStepAdvance', () => {
  it('holds a step for one advance and defers a second advance of the same step', async () => {
    const first = advance({ taskId: 't1', stepId: 's', round: 0 });
    const release = await holdStepAdvance(first.job, 'tok');
    expect(release).toBeTypeOf('function');

    const second = advance({ taskId: 't1', stepId: 's', round: 0 });
    const before = Date.now();
    await expect(holdStepAdvance(second.job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(second.moveToDelayed).toHaveBeenCalledTimes(1);
    const [until, token] = second.moveToDelayed.mock.calls[0]!;
    expect(token).toBe('tok');
    expect(until).toBeGreaterThanOrEqual(before + 5_000);

    release!();
    const third = advance({ taskId: 't1', stepId: 's', round: 0 });
    const again = await holdStepAdvance(third.job, 'tok');
    expect(again).toBeTypeOf('function');
    again!();
  });

  it('holds each task, step and round on its own', async () => {
    const held = await holdStepAdvance(advance({ taskId: 't2', stepId: 's', round: 0 }).job, 'tok');
    const others = await Promise.all(
      [
        { taskId: 't3', stepId: 's', round: 0 },
        { taskId: 't2', stepId: 'other', round: 0 },
        { taskId: 't2', stepId: 's', round: 1 },
      ].map((data) => holdStepAdvance(advance(data).job, 'tok')),
    );
    expect(others.every((r) => typeof r === 'function')).toBe(true);
    for (const release of [held, ...others]) release!();
  });

  it('waits for the holder, rather than running beside it, when it cannot be deferred', async () => {
    const release = await holdStepAdvance(advance({ taskId: 't4', stepId: 's' }).job, 'tok');
    const refused = advance({ taskId: 't4', stepId: 's' });
    refused.moveToDelayed.mockRejectedValueOnce(new Error('lock lost'));
    let taken = false;
    const waiting = holdStepAdvance(refused.job, 'tok').then((r) => {
      taken = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(taken).toBe(false);
    release!();
    const next = await waiting;
    expect(next).toBeTypeOf('function');
    next!();
  });

  it('takes a held step for one waiter at a time', async () => {
    const release = await holdStepAdvance(advance({ taskId: 't8', stepId: 's' }).job, 'tok');
    // No token to defer with, so both wait here.
    const taken: string[] = [];
    const releases = new Map<string, () => void>();
    for (const name of ['a', 'b']) {
      const tokenless = advance({ taskId: 't8', stepId: 's' });
      void holdStepAdvance(tokenless.job, undefined).then((r) => {
        taken.push(name);
        releases.set(name, r!);
      });
      expect(tokenless.moveToDelayed).not.toHaveBeenCalled();
    }
    release!();
    await vi.waitFor(() => expect(taken).toHaveLength(1), { timeout: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(taken).toHaveLength(1);
    releases.get(taken[0]!)!();
    await vi.waitFor(() => expect(taken).toHaveLength(2), { timeout: 3_000 });
    releases.get(taken[1]!)!();
  });

  it('holds nothing for a job with no step', async () => {
    expect(await holdStepAdvance(advance({ taskId: 't5' }).job, 'tok')).toBeNull();
  });
});

describe('processTaskJob', () => {
  it('defers an advance of a held step before any work, so the task is never failed for it', async () => {
    const release = await holdStepAdvance(advance({ taskId: 't6', stepId: 's' }).job, 'tok');
    const second = advance({ taskId: 't6', stepId: 's' });

    await expect(processTaskJob(second.job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(second.moveToDelayed).toHaveBeenCalledTimes(1);
    // The catch that fails the task needs the database; a deferral never reaches it.
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
    release!();
  });

  it('releases the hold when the advance fails', async () => {
    const first = advance({ taskId: 't7', stepId: 's' });
    await expect(processTaskJob(first.job, 'tok')).rejects.toThrow('no database in this test');
    const next = await holdStepAdvance(advance({ taskId: 't7', stepId: 's' }).job, 'tok');
    expect(next).toBeTypeOf('function');
    next!();
  });
});
