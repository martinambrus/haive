import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger, TASK_JOB_NAMES } from '@haive/shared';

// The continuation a finished CLI run queues (`resumeStepIfLinked`): the one job that resumes a step
// parked on its CLI. It is queued like every other advance, with retries and a backoff, so a
// processing failure that leaves the task running is tried again instead of leaving a parked step
// with no run to wait for and no job. A queue that refuses the add is asked again in the process,
// with the waits every recovery enqueue uses, before the refusal is left to the caller.

const h = vi.hoisted(() => ({
  adds: [] as { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[],
  run: { supersededAt: null as Date | null },
  /** How many of the next asks the queue refuses, and how many it was asked in all. */
  refusals: 0,
  tries: 0,
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      cliInvocations: { findFirst: async () => h.run },
      taskSteps: { findFirst: async () => ({ stepId: '07-phase-2-implement', round: 2 }) },
      tasks: { findFirst: async () => ({ orchestrationEpoch: 5 }) },
    },
  }),
}));
vi.mock('../src/queues/task-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/task-queue.js')>()),
  getTaskQueue: () => ({
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      h.tries++;
      if (h.refusals > 0) {
        h.refusals--;
        throw new Error('the queue refused the job');
      }
      h.adds.push({ name, data, opts });
    },
  }),
}));

import { resumeStepIfLinked } from '../src/queues/cli-exec/resolvers.js';
import { REDRIVE_RETRY_DELAYS_MS } from '../src/queues/task-queue.js';

const payload = {
  invocationId: 'run-1',
  taskStepId: 'row-1',
  taskId: 'task-1',
  userId: 'user-1',
} as unknown as Parameters<typeof resumeStepIfLinked>[0];

beforeEach(() => {
  h.adds.length = 0;
  h.run.supersededAt = null;
  h.refusals = 0;
  h.tries = 0;
});

describe('the continuation a finished CLI run queues', () => {
  it('names the step and round the run belongs to, at the epoch the task stands at', async () => {
    await resumeStepIfLinked(payload, true, null);
    expect(h.adds).toHaveLength(1);
    expect(h.adds[0]!.name).toBe(TASK_JOB_NAMES.ADVANCE_STEP);
    expect(h.adds[0]!.data).toEqual({
      taskId: 'task-1',
      userId: 'user-1',
      stepId: '07-phase-2-implement',
      epoch: 5,
      round: 2,
    });
  });

  it('is queued with the retries and backoff every other advance producer uses', async () => {
    await resumeStepIfLinked(payload, true, null);
    expect(h.adds[0]!.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  });

  it('carries no deduplication id and no job id: it shares an epoch with the pass that queued it', async () => {
    await resumeStepIfLinked(payload, true, null);
    expect(h.adds[0]!.opts).not.toHaveProperty('deduplication');
    expect(h.adds[0]!.opts).not.toHaveProperty('jobId');
  });

  it('queues nothing for a run a retry superseded', async () => {
    h.run.supersededAt = new Date();
    await resumeStepIfLinked(payload, true, null);
    expect(h.adds).toEqual([]);
  });
});

describe('a continuation the queue refuses', () => {
  const [first = 0, second = 0] = REDRIVE_RETRY_DELAYS_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is queued again in the process, as every recovery enqueue is, instead of waiting for the sweep', async () => {
    h.refusals = 1;
    const queued = resumeStepIfLinked(payload, true, null);
    await vi.advanceTimersByTimeAsync(first);
    await queued;
    expect(h.tries, 'the second ask went through').toBe(2);
    expect(h.adds).toHaveLength(1);
    expect(h.adds[0]!.data).toMatchObject({
      taskId: 'task-1',
      stepId: '07-phase-2-implement',
      round: 2,
      epoch: 5,
    });
  });

  it('is asked three times in all, then the refusal stands for the caller', async () => {
    h.refusals = Infinity;
    const queued = resumeStepIfLinked(payload, true, null);
    const refused = expect(queued).rejects.toThrow('the queue refused the job');
    await vi.advanceTimersByTimeAsync(first + second);
    await refused;
    expect(h.tries).toBe(3);
    expect(h.adds).toEqual([]);
  });
});
