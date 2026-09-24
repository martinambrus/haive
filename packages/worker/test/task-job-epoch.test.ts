import type { Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TASK_JOB_NAMES } from '@haive/shared';
import {
  handleResult,
  processTaskJob,
  setContainerCleanupRunner,
} from '../src/queues/task-queue.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

/** Values a drizzle condition binds, in order. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) conditionValues(item, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) acc.push(obj.value);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionValues(c, acc);
  return acc;
}

/** A running task at epoch 5 behind a db whose task writes land only while the epoch they name,
 *  if any, is still the task's. `onSelect` stands in for whatever the job does next. */
const h = vi.hoisted(() => {
  const state = {
    taskEpoch: 5,
    /** Reads answer empty instead of stopping the job. */
    readsAnswer: false,
    onSelect: (() => {}) as () => void,
    taskWrites: [] as { epochs: unknown[]; landed: boolean }[],
    events: [] as unknown[],
  };
  return { state };
});

const db = {
  query: {
    tasks: {
      findFirst: async () => ({
        id: 'task-1',
        userId: 'user-1',
        type: 'workflow',
        repositoryId: 'repo-1',
        status: 'running',
        orchestrationEpoch: h.state.taskEpoch,
        metadata: null,
        cliProviderId: null,
        ignoreSavedStepClis: false,
        executionPath: null,
        currentStepId: 'epoch-job-step',
        currentRound: 0,
      }),
    },
    repositories: { findFirst: async () => ({ storagePath: '/tmp/repo', localPath: null }) },
  },
  select: () => {
    h.state.onSelect();
    if (!h.state.readsAnswer) throw new Error('the job went no further');
    return { from: () => ({ where: async () => [] }) };
  },
  insert: () => ({
    values: async (v: { eventType?: unknown }) => {
      h.state.events.push(v.eventType);
    },
  }),
  update: () => ({
    set: () => ({
      where: (cond: unknown) => ({
        returning: async () => {
          const epochs = conditionValues(cond).filter((v) => typeof v === 'number');
          const landed = epochs.length === 0 || epochs.includes(h.state.taskEpoch);
          h.state.taskWrites.push({ epochs, landed });
          return landed ? [{ id: 'task-1' }] : [];
        },
      }),
    }),
  }),
};

vi.mock('../src/db.js', () => ({ getDb: () => db }));
vi.mock('../src/queues/_step-reset.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/_step-reset.js')>()),
  resetStepAndDownstream: vi.fn(async () => ({ newEpoch: 7 })),
}));

// 07 is the fix loop's fixed re-entry target.
for (const id of ['epoch-job-step', 'epoch-job-target', '07-phase-2-implement']) {
  stepRegistry.register({
    metadata: {
      id,
      workflowType: 'workflow',
      index: id === 'epoch-job-target' ? 0 : 1,
      title: id,
      description: 'a step whose job fails or revises',
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    async apply() {
      return {};
    },
  } as StepDefinition);
}

afterEach(() => {
  h.state.taskEpoch = 5;
  h.state.readsAnswer = false;
  h.state.onSelect = () => {};
  h.state.taskWrites = [];
  h.state.events = [];
  setContainerCleanupRunner(null);
});

describe('a task job that fails', () => {
  it('fails nothing once a Retry moved the task on while the job ran', async () => {
    const cleanup = vi.fn(async () => 0);
    setContainerCleanupRunner(cleanup);
    // The Retry lands, bumping the epoch, just before the job throws.
    h.state.onSelect = () => {
      h.state.taskEpoch = 6;
    };
    const job = {
      id: 'job-1',
      name: TASK_JOB_NAMES.ADVANCE_STEP,
      data: { taskId: 'task-1', userId: 'user-1', stepId: 'epoch-job-step', round: 0, epoch: 5 },
      timestamp: Date.now(),
      moveToDelayed: vi.fn(async () => undefined),
    } as unknown as Job;

    await expect(processTaskJob(job, 'tok')).rejects.toThrow('the job went no further');
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('fails a job that carries no epoch only at the one it read the task at', async () => {
    const cleanup = vi.fn(async () => 0);
    setContainerCleanupRunner(cleanup);
    h.state.onSelect = () => {
      h.state.taskEpoch = 6;
    };
    const job = {
      id: 'job-2',
      name: TASK_JOB_NAMES.ADVANCE_STEP,
      data: { taskId: 'task-1', userId: 'user-1', stepId: 'epoch-job-step', round: 0 },
      timestamp: Date.now(),
      moveToDelayed: vi.fn(async () => undefined),
    } as unknown as Job;

    await expect(processTaskJob(job, 'tok')).rejects.toThrow('the job went no further');
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe('a job that resets steps itself', () => {
  it('holds the task at the epoch its own reset moved it to', async () => {
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
    const revise = {
      status: 'revise',
      row: { id: 'ts-1', round: 0 },
      sourceStepId: 'epoch-job-step',
      targetStepId: 'epoch-job-target',
    };
    // The reset is the job's own, so a failure after it must land at the new epoch.
    await expect(
      handleResult(db as never, ctx as never, 'epoch-job-step', revise as never),
    ).rejects.toThrow('the job went no further');
    expect(ctx.orchestrationEpoch).toBe(7);
  });

  it('hands nothing off when its reset finds the task moved on', async () => {
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce('superseded');
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
    const revise = {
      status: 'revise',
      row: { id: 'ts-1', round: 0 },
      sourceStepId: 'epoch-job-step',
      targetStepId: 'epoch-job-target',
    };
    // Resolving at all shows it stopped before the task writes that follow a reset.
    await handleResult(db as never, ctx as never, 'epoch-job-step', revise as never);
    expect(vi.mocked(resetStepAndDownstream)).toHaveBeenLastCalledWith(
      db,
      'task-1',
      'epoch-job-target',
      1,
      5,
    );
    expect(ctx.orchestrationEpoch).toBe(5);
  });

  it('enters no fix round when its reset finds the task moved on', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce('superseded');
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
    const loopBack = {
      status: 'loop_back',
      row: { id: 'ts-1', round: 0 },
      diagnosis: 'a defect',
      sourceStepId: 'epoch-job-step',
      uncapped: true,
    };
    await handleResult(db as never, ctx as never, 'epoch-job-step', loopBack as never);
    const call = vi.mocked(resetStepAndDownstream).mock.lastCall!;
    expect(call[3]).toBe(1);
    expect(call[4]).toBe(5);
    expect(ctx.orchestrationEpoch).toBe(5);
    // The reset refused, so neither the pointer nor the task moved, and no round was recorded as
    // requested or started.
    expect(h.state.taskWrites).toEqual([]);
    expect(h.state.events).toEqual(['step.loop_back']);
  });
});
