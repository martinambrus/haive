import type { Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configService, TASK_JOB_NAMES } from '@haive/shared';
import {
  finishFailedStep,
  handleResult,
  holdStepAdvance,
  processTaskJob,
  resolveFixLoopGate,
  setContainerCleanupRunner,
} from '../src/queues/task-queue.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { advanceStep } from '../src/step-engine/index.js';
import { runtimeAdmission } from '../src/sandbox/runtime-admission.js';
import { PROVIDER_FATAL_HEADLINES } from '../src/queues/cli-exec/failure-class.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

function tableNameOf(table: unknown): string {
  if (table && typeof table === 'object') {
    const obj = table as Record<string, unknown>;
    const sym = Object.getOwnPropertySymbols(obj).find((s) => s.description === 'drizzle:Name');
    if (sym) {
      const name = obj[sym as unknown as string];
      if (typeof name === 'string') return name;
    }
  }
  return '';
}

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

interface Comparison {
  column: string;
  op: string;
  values: unknown[];
}

/** Each comparison a drizzle condition makes: the column it names, its operator and the values it
 *  binds (`eq`, `ne`, `inArray` and `notInArray` alike). */
function comparisons(node: unknown, acc: Comparison[] = []): Comparison[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) comparisons(item, acc);
    return acc;
  }
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  if (!Array.isArray(chunks)) return acc;
  const column = chunks.find(
    (c): c is { name: string } =>
      !!c && typeof c === 'object' && 'columnType' in c && typeof c.name === 'string',
  );
  const op = chunks
    .map((c) =>
      !!c && typeof c === 'object' && !('encoder' in c) && 'value' in c && Array.isArray(c.value)
        ? c.value.join('').trim()
        : '',
    )
    .find((text) => text !== '');
  if (column && op) {
    acc.push({ column: column.name, op, values: conditionValues(chunks) });
    return acc;
  }
  for (const c of chunks) comparisons(c, acc);
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
    /** Runs once a read of the task row has answered, so a Retry can land right after one. */
    onRead: (() => {}) as () => void,
    taskWrites: [] as { epochs: unknown[]; landed: boolean }[],
    events: [] as unknown[],
    /** What the task queue is asked to enqueue. */
    add: vi.fn(async (..._args: unknown[]) => undefined),
    /** The source row still reads as this pass's, not reset by a Retry. */
    sourceOwned: true,
    /** The task's fix-round cap; unset means the default. */
    maxFixRounds: undefined as number | undefined,
    /** What a read of the task's recorded fix requests answers. */
    requestedEvents: [] as unknown[],
    /** The task's status: a Stop fails it without moving the epoch. */
    taskStatus: 'running',
    /** Set to hold the task on a pause. */
    pausedAt: null as Date | null,
    /** The step row an advance reads before it runs the step. */
    existingRow: null as Record<string, unknown> | null,
    /** The row a park writes to, as upsertRow answers it. */
    parkRow: {} as Record<string, unknown>,
    /** What the runtime-admission gate answers. */
    admission: { decision: 'admit' } as Record<string, unknown>,
    /** Reads that confirm the job still holds the task. */
    taskHolds: [] as { epochs: unknown[]; landed: boolean }[],
    /** Every patch written to a step row. */
    stepPatches: [] as Record<string, unknown>[],
    /** Every patch a task write landed. */
    landedTaskPatches: [] as Record<string, unknown>[],
    taskType: 'workflow',
    currentStepId: 'epoch-job-step',
    /** Set when the task's repository is gone, so the job cannot resolve the task. */
    repoGone: false,
    /** Set when the task row itself cannot be read. */
    taskReadFails: false,
    /** What a read of a step's ended runs answers, newest first. */
    endedRuns: [] as Record<string, unknown>[],
    /** Set to fail the step's error-hint write and the usage-snapshot read. */
    hintWriteFails: false,
    snapshotReadFails: false,
  };
  return { state };
});

/** Whether a task write or read matches the task: every comparison it makes on the status or the
 *  epoch holds for the task as it stands. */
function taskMatches(cond: unknown): { epochs: unknown[]; landed: boolean } {
  const epochs = conditionValues(cond).filter((v) => typeof v === 'number');
  const status = h.state.taskStatus;
  const landed = comparisons(cond).every(({ column, op, values }) => {
    if (column === 'orchestration_epoch') return values[0] === h.state.taskEpoch;
    if (column !== 'status') return true;
    if (op === '=') return values[0] === status;
    if (op === 'in') return values.includes(status);
    if (op === 'not in') return !values.includes(status);
    throw new Error(`the fake does not model status ${op}`);
  });
  return { epochs, landed };
}

const db = {
  query: {
    tasks: {
      findFirst: async () => {
        if (h.state.taskReadFails) throw new Error('the task read failed');
        const task = {
          id: 'task-1',
          userId: 'user-1',
          type: h.state.taskType,
          repositoryId: 'repo-1',
          status: h.state.taskStatus,
          orchestrationEpoch: h.state.taskEpoch,
          metadata: null,
          cliProviderId: null,
          ignoreSavedStepClis: false,
          executionPath: null,
          currentStepId: h.state.currentStepId,
          currentRound: 0,
          maxFixRounds: h.state.maxFixRounds,
        };
        h.state.onRead();
        return task;
      },
    },
    repositories: {
      findFirst: async () =>
        h.state.repoGone ? undefined : { storagePath: '/tmp/repo', localPath: null },
    },
    cliProviders: { findFirst: async () => ({ name: 'claude-code' }) },
  },
  select: (fields?: Record<string, unknown>) => {
    h.state.onSelect();
    if (!h.state.readsAnswer) throw new Error('the job went no further');
    return {
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          const name = tableNameOf(table);
          // Awaited directly by some reads, cut with .limit() by others, and locked by the
          // hand-off and the park.
          return Object.assign(Promise.resolve([]), {
            limit: async () => {
              if (name === 'usage_window_snapshots' && h.state.snapshotReadFails) {
                throw new Error('the usage snapshot read failed');
              }
              if (fields && 'pausedAt' in fields) {
                return h.state.pausedAt ? [{ pausedAt: h.state.pausedAt }] : [];
              }
              if (!fields && name === 'task_steps' && h.state.existingRow) {
                return [h.state.existingRow];
              }
              return [];
            },
            for: async () => {
              if (name === 'tasks') {
                const held = taskMatches(cond);
                h.state.taskHolds.push(held);
                return held.landed ? [{ id: 'task-1' }] : [];
              }
              return h.state.sourceOwned ? [{ id: 'ts-1' }] : [];
            },
            orderBy: () => {
              const rows = name === 'cli_invocations' ? h.state.endedRuns : h.state.requestedEvents;
              return Object.assign(Promise.resolve(rows), { limit: async () => rows });
            },
          });
        },
      }),
    };
  },
  insert: () => ({
    values: async (v: { eventType?: unknown }) => {
      h.state.events.push(v.eventType);
    },
  }),
  update: (table: unknown) => ({
    set: (patch: Record<string, unknown>) => {
      if (tableNameOf(table) === 'task_steps') h.state.stepPatches.push(patch);
      return {
        where: (cond: unknown) => ({
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
            const failed = tableNameOf(table) === 'task_steps' && 'errorHint' in patch;
            return (
              failed && h.state.hintWriteFails
                ? Promise.reject(new Error('the hint write failed'))
                : Promise.resolve(undefined)
            ).then(resolve, reject);
          },
          returning: async () => {
            const values = conditionValues(cond);
            // A step row written under the ownership guard lands only while the pass still owns it.
            if (tableNameOf(table) === 'task_steps') {
              const guarded = values.includes('pending') && values.includes('skipped');
              return guarded && !h.state.sourceOwned ? [] : [{ id: 'ts-1' }];
            }
            const write = taskMatches(cond);
            h.state.taskWrites.push(write);
            if (write.landed) h.state.landedTaskPatches.push(patch);
            return write.landed ? [{ id: 'task-1' }] : [];
          },
        }),
      };
    },
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
vi.mock('../src/step-engine/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/step-engine/index.js')>()),
  upsertRow: vi.fn(async () => h.state.parkRow),
  advanceStep: vi.fn(async () => ({ status: 'superseded', row: h.state.parkRow })),
}));
vi.mock('../src/sandbox/runtime-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/runtime-admission.js')>()),
  runtimeAdmission: vi.fn(async () => h.state.admission),
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

// A two-step chain of a type no real step uses, so the forward walk has one successor to hand to.
for (const [id, index] of [
  ['epoch-chain-first', 0],
  ['epoch-chain-next', 1],
  ['epoch-chain-runtime', 2],
] as const) {
  stepRegistry.register({
    metadata: {
      id,
      workflowType: 'epoch_chain',
      index,
      title: id,
      description: 'a step whose successor is handed off',
      requiresCli: false,
    },
    ...(id === 'epoch-chain-runtime' ? { needsRuntime: 'ddev' } : {}),
    async detect() {
      return {};
    },
    async apply() {
      return {};
    },
  } as unknown as StepDefinition);
}

afterEach(() => {
  h.state.taskEpoch = 5;
  h.state.readsAnswer = false;
  h.state.onSelect = () => {};
  h.state.onRead = () => {};
  h.state.taskWrites = [];
  h.state.events = [];
  h.state.add.mockClear();
  h.state.sourceOwned = true;
  h.state.maxFixRounds = undefined;
  h.state.requestedEvents = [];
  h.state.taskStatus = 'running';
  h.state.pausedAt = null;
  h.state.existingRow = null;
  h.state.parkRow = {};
  h.state.admission = { decision: 'admit' };
  h.state.taskHolds = [];
  h.state.stepPatches = [];
  h.state.landedTaskPatches = [];
  h.state.taskType = 'workflow';
  h.state.currentStepId = 'epoch-job-step';
  h.state.repoGone = false;
  h.state.taskReadFails = false;
  h.state.endedRuns = [];
  h.state.hintWriteFails = false;
  h.state.snapshotReadFails = false;
  vi.restoreAllMocks();
  vi.mocked(advanceStep).mockClear();
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

describe("a failed step's hand-off", () => {
  it('records the step failure even when its hint cannot be read', async () => {
    setContainerCleanupRunner(vi.fn(async () => 0));
    // Every read throws here, the hint's lookup of the step's failed runs among them.
    await expect(
      finishFailedStep(
        db as never,
        { taskId: 'task-1', orchestrationEpoch: 5 },
        'epoch-job-step',
        { id: 'ts-1' },
        'boom',
      ),
    ).resolves.toBe(true);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: true }]);
    expect(h.state.events).toContain('step.failed');
  });

  const finish = () =>
    finishFailedStep(
      db as never,
      { taskId: 'task-1', orchestrationEpoch: 5 },
      'epoch-job-step',
      { id: 'ts-1' },
      'cli invocation failed',
    );
  const armed = () => h.state.landedTaskPatches.filter((p) => 'awaitingProviderReason' in p);
  const pollTicks = () =>
    h.state.add.mock.calls.filter((call) => call[0] !== TASK_JOB_NAMES.ADVANCE_STEP);
  const outage = (reason: 'rate_limit' | 'server_error') => {
    setContainerCleanupRunner(vi.fn(async () => 0));
    h.state.readsAnswer = true;
    // The fail write has landed by the time its teardown reads anything.
    h.state.onSelect = () => {
      h.state.taskStatus = 'failed';
    };
    h.state.endedRuns = [
      { errorMessage: `${PROVIDER_FATAL_HEADLINES[reason]}: 429`, cliProviderId: 'prov-1' },
    ];
  };

  it('arms the allowance watch though the hint write failed', async () => {
    outage('server_error');
    h.state.hintWriteFails = true;
    vi.spyOn(configService, 'get').mockResolvedValue('auto');
    await expect(finish()).resolves.toBe(true);
    expect(armed()).toEqual([expect.objectContaining({ awaitingProviderReason: 'server_error' })]);
  });

  it('arms it as if unset when its mode cannot be read', async () => {
    outage('server_error');
    vi.spyOn(configService, 'get').mockRejectedValue(new Error('config unreadable'));
    await expect(finish()).resolves.toBe(true);
    expect(armed()).toEqual([expect.objectContaining({ awaitingProviderReason: 'server_error' })]);
  });

  it('arms nothing, and wakes no poller, once a Retry moved the task on', async () => {
    outage('server_error');
    vi.spyOn(configService, 'get').mockResolvedValue('auto');
    // The Retry is clicked on the failure while its teardown runs.
    h.state.onSelect = () => {
      h.state.taskStatus = 'queued';
      h.state.taskEpoch = 6;
    };
    await expect(finish()).resolves.toBe(true);
    expect(armed()).toEqual([]);
    expect(h.state.taskWrites.slice(1)).toEqual([{ epochs: [5], landed: false }]);
    expect(pollTicks()).toEqual([]);
  });

  it('arms it with no reset time when the usage snapshot cannot be read', async () => {
    outage('rate_limit');
    h.state.snapshotReadFails = true;
    vi.spyOn(configService, 'get').mockResolvedValue('auto');
    await expect(finish()).resolves.toBe(true);
    expect(armed()).toEqual([
      expect.objectContaining({ awaitingProviderReason: 'rate_limit', allowanceResetAt: null }),
    ]);
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

describe('a hand-off that a Retry overtakes after its epoch check', () => {
  const ctx = () => ({
    taskId: 'task-1',
    userId: 'user-1',
    orchestrationEpoch: 5,
    workflowType: 'epoch_chain',
  });
  const row = { id: 'ts-1', round: 0 };
  const retryLands = () => {
    h.state.taskEpoch = 6;
  };

  it('hands the successor off at the epoch the job holds', async () => {
    h.state.readsAnswer = true;
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', {
      status: 'done',
      row,
      output: null,
    } as never);
    expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: true });
    expect(h.state.add).toHaveBeenCalledTimes(1);
    expect(h.state.add.mock.lastCall?.[1]).toMatchObject({
      stepId: 'epoch-chain-next',
      epoch: 5,
    });
  });

  it('hands no successor off once a Retry moved the task on', async () => {
    h.state.readsAnswer = true;
    h.state.onSelect = retryLands;
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', {
      status: 'done',
      row,
      output: null,
    } as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(h.state.add).not.toHaveBeenCalled();
  });

  it('hands no successor off once a Stop failed the task', async () => {
    h.state.readsAnswer = true;
    // A Stop fails the task without moving the epoch.
    h.state.onSelect = () => {
      h.state.taskStatus = 'failed';
    };
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', {
      status: 'done',
      row,
      output: null,
    } as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(h.state.add).not.toHaveBeenCalled();
  });

  it('completes nothing, and releases nothing, once a Stop failed the task', async () => {
    h.state.readsAnswer = true;
    h.state.onRead = () => {
      h.state.taskStatus = 'failed';
    };
    const cleanup = vi.fn(async () => 0);
    setContainerCleanupRunner(cleanup);
    // The chain's last step, so its hand-off is the task's completion.
    await handleResult(db as never, ctx() as never, 'epoch-chain-runtime', {
      status: 'done',
      row,
      output: null,
    } as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('marks a stopped task running on no parked run', async () => {
    h.state.readsAnswer = true;
    h.state.onRead = () => {
      h.state.taskStatus = 'failed';
    };
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', {
      status: 'waiting_cli',
      row,
    } as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(h.state.events).not.toContain('step.waiting_cli');
  });

  it('releases what a task a Stop failed holds once the pass it stopped lets go', async () => {
    h.state.readsAnswer = true;
    h.state.taskStatus = 'failed';
    const cleanup = vi.fn(async () => 0);
    setContainerCleanupRunner(cleanup);
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', {
      status: 'superseded',
      row,
    } as never);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('releases nothing for a pass a Retry or a Skip replaced', async () => {
    h.state.readsAnswer = true;
    const cleanup = vi.fn(async () => 0);
    setContainerCleanupRunner(cleanup);
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', {
      status: 'superseded',
      row,
    } as never);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('parks the task on no form once a Retry moved it on', async () => {
    h.state.readsAnswer = true;
    h.state.onSelect = retryLands;
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', {
      status: 'waiting_form',
      row,
      formSchema: {},
    } as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(h.state.events).not.toContain('step.waiting_form');
  });

  it('marks the task running on no parked run once a Retry moved it on', async () => {
    h.state.readsAnswer = true;
    // Straight after the hand-off's own epoch check, which is the task read it makes.
    h.state.onRead = retryLands;
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', {
      status: 'waiting_cli',
      row,
    } as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(h.state.events).not.toContain('step.waiting_cli');
  });

  it('raises no round-cap gate on a task a Retry moved on', async () => {
    h.state.readsAnswer = true;
    h.state.maxFixRounds = 0;
    h.state.onSelect = retryLands;
    const capped = {
      status: 'loop_back',
      row,
      diagnosis: 'a defect',
      sourceStepId: 'epoch-chain-first',
    };
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', capped as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(h.state.events).not.toContain('fix_loop.escalated');
  });

  it('raises no oscillation gate on a task a Retry moved on', async () => {
    h.state.readsAnswer = true;
    h.state.onSelect = retryLands;
    // The same complaint two rounds back, and another step's between them.
    h.state.requestedEvents = [
      { payload: { diagnosis: 'a defect', sourceStepId: 'epoch-chain-first', round: 1 } },
      { payload: { diagnosis: 'a different defect', sourceStepId: 'another-step', round: 2 } },
    ];
    const repeated = {
      status: 'loop_back',
      row: { id: 'ts-1', round: 2 },
      diagnosis: 'a defect',
      sourceStepId: 'epoch-chain-first',
    };
    await handleResult(db as never, ctx() as never, 'epoch-chain-first', repeated as never);
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(h.state.events).not.toContain('fix_loop.oscillation_detected');
    expect(h.state.events).toContain('fix_loop.requested');
  });

  describe('resolving the fix-loop gate', () => {
    const gate = { id: 'ts-1', stepId: 'epoch-chain-first', round: 1 };

    it('resolves nothing once a Retry reset the gate', async () => {
      h.state.readsAnswer = true;
      h.state.sourceOwned = false;
      await resolveFixLoopGate(db as never, ctx() as never, gate as never, 'accept', 1, '');
      expect(h.state.events).toEqual([]);
      expect(h.state.taskWrites).toEqual([]);
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('hands an accepted chain off only at the epoch the job holds', async () => {
      h.state.readsAnswer = true;
      h.state.onSelect = retryLands;
      await resolveFixLoopGate(db as never, ctx() as never, gate as never, 'accept', 1, '');
      expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('re-enters implementation only at the epoch the job holds', async () => {
      h.state.readsAnswer = true;
      h.state.onSelect = retryLands;
      await resolveFixLoopGate(db as never, ctx() as never, gate as never, 'continue', 1, '');
      expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('reopens a task that failed while its gate waited, answering accept', async () => {
      h.state.readsAnswer = true;
      h.state.taskStatus = 'failed';
      const failedCtx = { ...ctx(), status: 'failed' };
      await resolveFixLoopGate(db as never, failedCtx as never, gate as never, 'accept', 1, '');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: true });
      expect(h.state.add.mock.lastCall?.[1]).toMatchObject({ stepId: 'epoch-chain-next' });
    });

    it('reopens a task that failed while its gate waited, answering continue', async () => {
      h.state.readsAnswer = true;
      h.state.taskStatus = 'failed';
      const failedCtx = { ...ctx(), status: 'failed' };
      await resolveFixLoopGate(db as never, failedCtx as never, gate as never, 'continue', 1, '');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: true });
      expect(h.state.add.mock.lastCall?.[1]).toMatchObject({ stepId: '07-phase-2-implement' });
    });

    it('completes a task that failed while its last gate waited, answering accept', async () => {
      h.state.readsAnswer = true;
      h.state.taskStatus = 'failed';
      const cleanup = vi.fn(async () => 0);
      setContainerCleanupRunner(cleanup);
      const lastGate = { ...gate, stepId: 'epoch-chain-runtime' };
      const failedCtx = { ...ctx(), status: 'failed' };
      await resolveFixLoopGate(db as never, failedCtx as never, lastGate as never, 'accept', 1, '');
      // The completion lands; bookkeeping after it writes the task again.
      expect(h.state.taskWrites).toContainEqual({ epochs: [5], landed: true });
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('leaves a task a Stop failed during the answer stopped', async () => {
      h.state.readsAnswer = true;
      // Running when the job picked it up, so the answer is not what reopens it.
      h.state.onSelect = () => {
        h.state.taskStatus = 'failed';
      };
      await resolveFixLoopGate(db as never, ctx() as never, gate as never, 'continue', 1, '');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: false });
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('re-enters implementation at the next round while the task is still at its epoch', async () => {
      h.state.readsAnswer = true;
      await resolveFixLoopGate(db as never, ctx() as never, gate as never, 'continue', 1, '');
      expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: true }]);
      expect(h.state.add.mock.lastCall?.[1]).toMatchObject({
        stepId: '07-phase-2-implement',
        round: 2,
        epoch: 5,
      });
    });
  });
});

describe('a park or a step start that a Retry or a Stop overtakes', () => {
  const job = (stepId: string, extra: Record<string, unknown> = {}) => {
    // Every hand-off points the task at a step before it queues the step's advance.
    h.state.currentStepId = stepId;
    return {
      id: 'job-park',
      name: TASK_JOB_NAMES.ADVANCE_STEP,
      data: { taskId: 'task-1', userId: 'user-1', stepId, round: 0, epoch: 5, ...extra },
      timestamp: Date.now(),
      moveToDelayed: vi.fn(async () => undefined),
    } as unknown as Job;
  };
  const unparked = {
    id: 'ts-1',
    status: 'pending',
    waitingStartedAt: null,
    startedAt: null,
    endedAt: null,
    idleMs: 0,
    userActiveMs: 0,
    carriedWorkMs: 0,
    carriedIdleMs: 0,
    carriedUserActiveMs: 0,
  };
  // The first read after the job picked the task up, so the job's own epoch check has passed.
  const retryLands = () => {
    h.state.taskEpoch = 6;
  };
  const stopLands = () => {
    h.state.taskStatus = 'failed';
  };
  const parkQueued = (delay: number) => {
    expect(h.state.add).toHaveBeenCalledTimes(1);
    expect(h.state.add.mock.lastCall?.[1]).toMatchObject({ stepId: expect.any(String), epoch: 5 });
    expect(h.state.add.mock.lastCall?.[2]).toMatchObject({ delay });
  };

  describe('on a pause', () => {
    afterEach(() => {
      // Every case here wrote its park, so none of them passes by never parking at all.
      expect(
        h.state.stepPatches.some((p) => String(p.statusMessage ?? '').startsWith('Paused')),
      ).toBe(true);
    });
    it('parks the step and keeps polling while the job holds the task', async () => {
      h.state.readsAnswer = true;
      h.state.pausedAt = new Date();
      h.state.parkRow = unparked;
      await processTaskJob(job('epoch-chain-first'), 'tok');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: true });
      parkQueued(30_000);
    });

    it('parks nothing once a Retry moved the task on', async () => {
      h.state.readsAnswer = true;
      h.state.pausedAt = new Date();
      h.state.parkRow = unparked;
      h.state.onSelect = retryLands;
      await processTaskJob(job('epoch-chain-first'), 'tok');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: false });
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('parks nothing once a Stop failed the task', async () => {
      h.state.readsAnswer = true;
      h.state.pausedAt = new Date();
      h.state.parkRow = unparked;
      h.state.onSelect = stopLands;
      await processTaskJob(job('epoch-chain-first'), 'tok');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: false });
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('re-parks a step already parked only while the job still holds the task', async () => {
      h.state.readsAnswer = true;
      h.state.pausedAt = new Date();
      // Already parked, and the task points at it, so the tick only confirms its hold.
      h.state.parkRow = { ...unparked, waitingStartedAt: new Date() };
      h.state.onSelect = retryLands;
      await processTaskJob(job('epoch-job-step'), 'tok');
      expect(h.state.taskHolds).toEqual([{ epochs: [5], landed: false }]);
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('keeps a parked step polling while the job holds the task', async () => {
      h.state.readsAnswer = true;
      h.state.pausedAt = new Date();
      h.state.parkRow = { ...unparked, waitingStartedAt: new Date() };
      await processTaskJob(job('epoch-job-step'), 'tok');
      expect(h.state.taskHolds).toEqual([{ epochs: [5], landed: true }]);
      parkQueued(30_000);
    });
  });

  describe('on the runtime pool', () => {
    afterEach(() => {
      // Every case here reached the gate, so none of them passes by never parking at all.
      expect(vi.mocked(runtimeAdmission)).toHaveBeenCalled();
      vi.mocked(runtimeAdmission).mockClear();
    });
    const full = {
      decision: 'park',
      position: 1,
      waiting: 1,
      busyMb: 1,
      budgetMb: 1,
      myWeightMb: 1,
    };

    it('parks the step and keeps polling while the job holds the task', async () => {
      h.state.readsAnswer = true;
      h.state.admission = full;
      h.state.parkRow = unparked;
      await processTaskJob(job('epoch-chain-runtime'), 'tok');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: true });
      parkQueued(15_000);
    });

    it('parks nothing once a Retry moved the task on', async () => {
      h.state.readsAnswer = true;
      h.state.admission = full;
      h.state.parkRow = unparked;
      h.state.onSelect = retryLands;
      await processTaskJob(job('epoch-chain-runtime'), 'tok');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: false });
      expect(h.state.add).not.toHaveBeenCalled();
    });

    it('re-parks a step already parked only while the job still holds the task', async () => {
      h.state.readsAnswer = true;
      h.state.admission = full;
      // Already parked, and the task points at it, so the tick only confirms its hold.
      h.state.parkRow = { ...unparked, waitingStartedAt: new Date() };
      h.state.onSelect = retryLands;
      await processTaskJob(job('epoch-chain-runtime'), 'tok');
      expect(h.state.taskHolds).toEqual([{ epochs: [5], landed: false }]);
      expect(h.state.add).not.toHaveBeenCalled();
    });
  });

  describe('when the step is about to run', () => {
    it('runs it while the job holds the task', async () => {
      h.state.readsAnswer = true;
      await processTaskJob(job('epoch-chain-first'), 'tok');
      expect(vi.mocked(advanceStep)).toHaveBeenCalledTimes(1);
    });

    it('does not run it once a Stop failed the task', async () => {
      h.state.readsAnswer = true;
      h.state.onSelect = stopLands;
      await processTaskJob(job('epoch-chain-first'), 'tok');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: false });
      expect(vi.mocked(advanceStep)).not.toHaveBeenCalled();
    });

    it('does not run it once a Retry moved the task on', async () => {
      h.state.readsAnswer = true;
      h.state.onSelect = retryLands;
      await processTaskJob(job('epoch-chain-first'), 'tok');
      expect(vi.mocked(advanceStep)).not.toHaveBeenCalled();
    });

    it('does not run a form answer once a Stop failed the task after the job picked it up', async () => {
      h.state.readsAnswer = true;
      h.state.existingRow = {
        ...unparked,
        stepId: 'epoch-chain-first',
        round: 0,
        status: 'waiting_form',
        formValues: null,
      };
      h.state.onSelect = stopLands;
      await processTaskJob(job('epoch-chain-first', { formValues: { answer: 'yes' } }), 'tok');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: false });
      expect(vi.mocked(advanceStep)).not.toHaveBeenCalled();
    });

    // Its job died between failing the step and failing the task; every reopen resets the row first.
    it('fails the task for a failed row instead of running the row', async () => {
      h.state.readsAnswer = true;
      setContainerCleanupRunner(vi.fn(async () => 0));
      h.state.existingRow = {
        ...unparked,
        stepId: 'epoch-chain-first',
        round: 0,
        status: 'failed',
        errorMessage: 'kaboom',
      };
      await processTaskJob(job('epoch-chain-first'), 'tok');
      expect(vi.mocked(advanceStep)).not.toHaveBeenCalled();
      expect(h.state.landedTaskPatches.at(-1)).toMatchObject({
        status: 'failed',
        errorMessage: 'kaboom',
      });
      expect(h.state.events).toContain('step.failed');
    });

    it('runs an answer to a form still parked on a failed task, which reopens it', async () => {
      h.state.readsAnswer = true;
      h.state.taskStatus = 'failed';
      h.state.existingRow = {
        ...unparked,
        stepId: 'epoch-chain-first',
        round: 0,
        status: 'waiting_form',
        formValues: null,
      };
      await processTaskJob(job('epoch-chain-first', { formValues: { answer: 'yes' } }), 'tok');
      expect(h.state.taskWrites.at(-1)).toEqual({ epochs: [5], landed: true });
      expect(vi.mocked(advanceStep)).toHaveBeenCalledTimes(1);
    });
  });
});

describe('an advance for a step the task has moved past', () => {
  it('neither runs the step nor points the task back at it', async () => {
    h.state.readsAnswer = true;
    // The task went on to another step while this advance sat in the queue.
    h.state.currentStepId = 'epoch-job-target';
    const job = {
      id: 'job-left-over',
      name: TASK_JOB_NAMES.ADVANCE_STEP,
      data: { taskId: 'task-1', userId: 'user-1', stepId: 'epoch-job-step', round: 0, epoch: 5 },
      timestamp: Date.now(),
      moveToDelayed: vi.fn(async () => undefined),
    } as unknown as Job;

    await processTaskJob(job, 'tok');

    expect(vi.mocked(advanceStep)).not.toHaveBeenCalled();
    expect(h.state.landedTaskPatches).toEqual([]);
  });
});

describe('a START job', () => {
  const start = () =>
    ({
      id: 'job-start',
      name: TASK_JOB_NAMES.START,
      data: { taskId: 'task-1', userId: 'user-1' },
      timestamp: Date.now(),
      moveToDelayed: vi.fn(async () => undefined),
    }) as unknown as Job;

  it.each(['created', 'queued'])('claims a %s task and runs its first step', async (status) => {
    h.state.readsAnswer = true;
    h.state.taskType = 'epoch_chain';
    h.state.taskStatus = status;
    await processTaskJob(start(), 'tok');
    expect(h.state.taskWrites[0]).toEqual({ epochs: [5], landed: true });
    expect(h.state.landedTaskPatches[0]).toMatchObject({
      status: 'running',
      currentStepId: 'epoch-chain-first',
      currentRound: 0,
    });
    expect(h.state.events).toContain('task.running');
    expect(vi.mocked(advanceStep)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(advanceStep).mock.lastCall?.[0]).toMatchObject({
      stepDef: { metadata: { id: 'epoch-chain-first' } },
      epoch: 5,
    });
  });

  it.each(['running', 'waiting_user', 'failed', 'cancelled', 'completed'])(
    'does nothing to a %s task',
    async (status) => {
      h.state.readsAnswer = true;
      h.state.taskType = 'epoch_chain';
      h.state.taskStatus = status;
      await processTaskJob(start(), 'tok');
      expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
      expect(h.state.events).toEqual([]);
      expect(vi.mocked(advanceStep)).not.toHaveBeenCalled();
      expect(h.state.add).not.toHaveBeenCalled();
    },
  );

  it('runs its first step only once a pass still on it lets go', async () => {
    h.state.readsAnswer = true;
    h.state.taskType = 'epoch_chain';
    h.state.taskStatus = 'queued';
    // A pass a Stop cut off is still on the first step when the Retry's START arrives.
    const old = { taskId: 'task-1', stepId: 'epoch-chain-first', round: 0 };
    const release = await holdStepAdvance(
      { id: 'job-old', data: old, moveToDelayed: vi.fn() } as never,
      undefined,
    );
    try {
      const started = processTaskJob(start(), 'tok');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(vi.mocked(advanceStep)).not.toHaveBeenCalled();
      release?.();
      await started;
      expect(vi.mocked(advanceStep)).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
    }
  });

  it('claims nothing once the task moved to another epoch after START read it', async () => {
    h.state.readsAnswer = true;
    h.state.taskType = 'epoch_chain';
    h.state.taskStatus = 'queued';
    // After the context read and before the claim, as a cancel's epoch bump would land.
    h.state.onSelect = () => {
      h.state.taskEpoch = 6;
    };
    await processTaskJob(start(), 'tok');
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(vi.mocked(advanceStep)).not.toHaveBeenCalled();
  });

  it('fails nothing when it cannot resolve a task that was cancelled', async () => {
    const cleanup = vi.fn(async () => 0);
    setContainerCleanupRunner(cleanup);
    // Deleting a repository cancels its open tasks, so a START still queued finds no repository.
    h.state.taskStatus = 'cancelled';
    h.state.repoGone = true;
    await expect(processTaskJob(start(), 'tok')).rejects.toThrow('no resolvable repo path');
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('fails nothing a Retry re-queued while a START that read it failed could not resolve it', async () => {
    h.state.taskStatus = 'failed';
    h.state.repoGone = true;
    // The Retry lands once START has read the task and before its repository read throws.
    h.state.onRead = () => {
      h.state.taskStatus = 'queued';
      h.state.taskEpoch = 6;
    };
    await expect(processTaskJob(start(), 'tok')).rejects.toThrow('no resolvable repo path');
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
  });

  it('fails nothing a Retry re-queued while a START that read it failed was before its claim', async () => {
    h.state.taskType = 'epoch_chain';
    h.state.taskStatus = 'failed';
    // The Retry lands once START has read the task, and the claim's own read then throws.
    h.state.onRead = () => {
      h.state.taskStatus = 'queued';
      h.state.taskEpoch = 6;
    };
    await expect(processTaskJob(start(), 'tok')).rejects.toThrow('the job went no further');
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: false }]);
  });

  it('fails nothing when it could not read the task at all', async () => {
    // Queued, as a Retry leaves it: with no epoch read, this START cannot tell that generation
    // from the one it was sent for.
    h.state.taskStatus = 'queued';
    h.state.taskReadFails = true;
    await expect(processTaskJob(start(), 'tok')).rejects.toThrow('the task read failed');
    expect(h.state.taskWrites).toEqual([]);
  });

  it('fails a task still waiting to start when it cannot resolve it', async () => {
    h.state.taskStatus = 'queued';
    h.state.repoGone = true;
    await expect(processTaskJob(start(), 'tok')).rejects.toThrow('no resolvable repo path');
    expect(h.state.taskWrites).toEqual([{ epochs: [5], landed: true }]);
  });

  it('points a paused, retried task at its first step, so a first step already done hands off', async () => {
    h.state.readsAnswer = true;
    h.state.taskType = 'epoch_chain';
    h.state.taskStatus = 'queued';
    h.state.pausedAt = new Date();
    // The step the task failed on, where a task Retry leaves the pointer.
    h.state.currentStepId = 'epoch-chain-runtime';
    await processTaskJob(start(), 'tok');
    expect(vi.mocked(advanceStep)).not.toHaveBeenCalled();
    expect(h.state.add).toHaveBeenCalledTimes(1);
    expect(h.state.add.mock.lastCall?.[1]).toMatchObject({
      stepId: 'epoch-chain-first',
      round: 0,
      epoch: 5,
    });

    // The claim's write as the database applied it, then the advance START queued.
    h.state.taskStatus = 'running';
    h.state.currentStepId = String(h.state.landedTaskPatches[0]?.currentStepId);
    h.state.pausedAt = null;
    h.state.existingRow = {
      id: 'ts-1',
      stepId: 'epoch-chain-first',
      round: 0,
      status: 'done',
      output: null,
      errorMessage: null,
      formValues: null,
    };
    h.state.add.mockClear();
    const advance = {
      id: 'job-advance',
      name: TASK_JOB_NAMES.ADVANCE_STEP,
      data: { taskId: 'task-1', userId: 'user-1', stepId: 'epoch-chain-first', round: 0, epoch: 5 },
      timestamp: Date.now(),
      moveToDelayed: vi.fn(async () => undefined),
    } as unknown as Job;
    await processTaskJob(advance, 'tok');
    expect(h.state.add).toHaveBeenCalledTimes(1);
    expect(h.state.add.mock.lastCall?.[1]).toMatchObject({ stepId: 'epoch-chain-next', epoch: 5 });
  });
});
