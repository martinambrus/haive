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
    /** What the task queue is asked to enqueue. */
    add: vi.fn(async (..._args: unknown[]) => undefined),
    /** The source row still reads as this pass's, not reset by a Retry. */
    sourceOwned: true,
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
    // Awaited directly by some reads, cut with .limit() by others, and locked by the hand-off.
    const rows = Object.assign(Promise.resolve([]), {
      limit: async () => [],
      for: async () => (h.state.sourceOwned ? [{ id: 'ts-1' }] : []),
    });
    return { from: () => ({ where: () => rows }) };
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
  transaction: async (fn: (tx: unknown) => unknown) => fn(db),
};

vi.mock('../src/db.js', () => ({ getDb: () => db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    add(...args: unknown[]) {
      return h.state.add(...args);
    }
  },
}));
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
  h.state.add.mockClear();
  h.state.sourceOwned = true;
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
  const revise = {
    status: 'revise',
    row: { id: 'ts-1', round: 0 },
    sourceStepId: 'epoch-job-step',
    targetStepId: 'epoch-job-target',
  };
  // Uncapped, as a person's reject is, so no round cap or oscillation check stands in the way.
  const loopBack = {
    status: 'loop_back',
    row: { id: 'ts-1', round: 0 },
    diagnosis: 'a defect',
    sourceStepId: 'epoch-job-step',
    uncapped: true,
  };

  it('holds the task at the epoch its own reset moved it to', async () => {
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
    // The reset is the job's own, so a failure after it must land at the new epoch.
    await expect(
      handleResult(db as never, ctx as never, 'epoch-job-step', revise as never),
    ).rejects.toThrow('the job went no further');
    expect(ctx.orchestrationEpoch).toBe(7);
  });

  it('hands nothing off when its reset finds the task moved on', async () => {
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce('superseded');
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
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

  it('enters no fix round when a Retry moved the task on after its reset', async () => {
    h.state.readsAnswer = true;
    // A new round has no row to reset, so the reset takes no swap; the Retry lands while the job
    // counts the rounds already spent, after the hand-off's own epoch check.
    h.state.onSelect = () => {
      h.state.taskEpoch = 6;
    };
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce(null);
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
    await handleResult(db as never, ctx as never, 'epoch-job-step', loopBack as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    // No round recorded as requested or started, and nothing queued for it.
    expect(h.state.events).toEqual(['step.loop_back']);
    expect(h.state.add).not.toHaveBeenCalled();
  });

  it('enters no fix round once a Retry reset its source step, whatever the epoch', async () => {
    h.state.readsAnswer = true;
    // The Retry has written the steps and not yet the task, so the epoch still matches.
    h.state.sourceOwned = false;
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce(null);
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
    await handleResult(db as never, ctx as never, 'epoch-job-step', loopBack as never);
    expect(h.state.taskWrites).toEqual([]);
    expect(h.state.events).toEqual(['step.loop_back']);
    expect(h.state.add).not.toHaveBeenCalled();
  });

  it('enters and records the fix round while the task is still at its epoch', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce(null);
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
    await handleResult(db as never, ctx as never, 'epoch-job-step', loopBack as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: true }]);
    expect(h.state.events).toEqual(['step.loop_back', 'fix_loop.requested', 'fix_loop.started']);
    expect(h.state.add).toHaveBeenCalledTimes(1);
    expect(h.state.add.mock.lastCall?.[1]).toMatchObject({ round: 1, epoch: 5 });
  });

  it('hands a revise nothing once a Retry moved the task on after its reset', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockImplementationOnce(async () => {
      h.state.taskEpoch = 7;
      return { downstreamReset: 0, newEpoch: 7 };
    });
    // The Retry lands after the job's own reset, while it reads where to point the task.
    h.state.onSelect = () => {
      h.state.taskEpoch = 8;
    };
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
    await handleResult(db as never, ctx as never, 'epoch-job-step', revise as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [7], landed: false }]);
    expect(h.state.add).not.toHaveBeenCalled();
  });

  it('hands a revise off at the epoch its own reset moved the task to', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockImplementationOnce(async () => {
      h.state.taskEpoch = 7;
      return { downstreamReset: 0, newEpoch: 7 };
    });
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
    await handleResult(db as never, ctx as never, 'epoch-job-step', revise as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [7], landed: true }]);
    expect(h.state.add).toHaveBeenCalledTimes(1);
    expect(h.state.add.mock.lastCall?.[1]).toMatchObject({ round: 1, epoch: 7 });
  });

  it('enters no fix round when its reset finds the task moved on', async () => {
    h.state.readsAnswer = true;
    vi.mocked(resetStepAndDownstream).mockResolvedValueOnce('superseded');
    const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 };
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
