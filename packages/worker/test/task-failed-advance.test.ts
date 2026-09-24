import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_JOB_NAMES } from '@haive/shared';
import { processTaskJob } from '../src/queues/task-queue.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

/** A failed task and one step row, behind a db that answers the reads an advance starts with and
 *  records every write it is sent. The first step read is the other-active guard's, the second the
 *  advance's own row. */
const h = vi.hoisted(() => {
  const state = {
    rowStatus: 'failed',
    reads: 0,
    writes: [] as string[],
  };
  const db = {
    query: {
      tasks: {
        findFirst: async () => ({
          id: 'task-1',
          userId: 'user-1',
          type: 'workflow',
          repositoryId: 'repo-1',
          status: 'failed',
          orchestrationEpoch: 5,
          metadata: null,
          cliProviderId: null,
          ignoreSavedStepClis: false,
          executionPath: null,
          currentStepId: 'failed-advance-step',
          currentRound: 0,
        }),
      },
      repositories: { findFirst: async () => ({ storagePath: '/tmp/repo', localPath: null }) },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            state.reads++ === 0 ? [] : [{ id: 'ts-1', status: state.rowStatus, round: 0 }],
        }),
      }),
    }),
    update: () => {
      state.writes.push('update');
      throw new Error('an advance kept out writes nothing');
    },
    insert: () => {
      state.writes.push('insert');
      throw new Error('an advance kept out writes nothing');
    },
  };
  return { state, db };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

stepRegistry.register({
  metadata: {
    id: 'failed-advance-step',
    workflowType: 'workflow',
    index: 0,
    title: 'failed advance step',
    description: 'a step whose pass failed it',
    requiresCli: false,
  },
  async detect() {
    return {};
  },
  async apply() {
    return {};
  },
} as StepDefinition);

function advanceJob(extra: Record<string, unknown> = {}): Job {
  return {
    id: 'job-1',
    name: TASK_JOB_NAMES.ADVANCE_STEP,
    data: {
      taskId: 'task-1',
      userId: 'user-1',
      stepId: 'failed-advance-step',
      round: 0,
      epoch: 5,
      ...extra,
    },
    timestamp: Date.now(),
    moveToDelayed: vi.fn(async () => undefined),
  } as unknown as Job;
}

describe('an advance queued before its task failed', () => {
  beforeEach(() => {
    h.state.reads = 0;
    h.state.writes = [];
  });

  it('is dropped once the pass it was deferred behind failed the step', async () => {
    h.state.rowStatus = 'failed';
    await processTaskJob(advanceJob(), 'tok');
    expect(h.state.reads).toBe(2);
    expect(h.state.writes).toEqual([]);
  });

  it('is dropped when that pass threw and left the step parked', async () => {
    h.state.rowStatus = 'waiting_cli';
    await processTaskJob(advanceJob(), 'tok');
    expect(h.state.writes).toEqual([]);
  });

  it('is dropped when it lands on a form still parked but carries no answer', async () => {
    h.state.rowStatus = 'waiting_form';
    await processTaskJob(advanceJob(), 'tok');
    expect(h.state.writes).toEqual([]);
  });

  it('lets an answer submitted to that form through, as before', async () => {
    h.state.rowStatus = 'waiting_form';
    // Past the guard the advance goes on to the step's own work, which this db does not serve.
    await processTaskJob(advanceJob({ formValues: { answer: 'yes' } }), 'tok').catch(() => {});
    expect(h.state.writes).not.toEqual([]);
  });
});
