import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_JOB_NAMES } from '@haive/shared';

// The continuation a finished CLI run queues (`resumeStepIfLinked`): the one job that resumes a step
// parked on its CLI. It is queued like every other advance, with retries and a backoff, so a
// processing failure that leaves the task running is tried again instead of leaving a parked step
// with no run to wait for and no job.

const h = vi.hoisted(() => ({
  adds: [] as { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[],
  run: { supersededAt: null as Date | null },
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
      h.adds.push({ name, data, opts });
    },
  }),
}));

import { resumeStepIfLinked } from '../src/queues/cli-exec/resolvers.js';

const payload = {
  invocationId: 'run-1',
  taskStepId: 'row-1',
  taskId: 'task-1',
  userId: 'user-1',
} as unknown as Parameters<typeof resumeStepIfLinked>[0];

beforeEach(() => {
  h.adds.length = 0;
  h.run.supersededAt = null;
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
