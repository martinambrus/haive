import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const stubs = vi.hoisted(() => ({ finishFailedStep: vi.fn(async (..._args: unknown[]) => true) }));

vi.mock('../src/queues/task-queue.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  finishFailedStep: stubs.finishFailedStep,
}));

import {
  defaultDeps,
  redriveStalledTasks,
  taskQueueOwed,
  type FailedStep,
} from '../src/queues/stalled-redrive.js';

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

/** Every column referenced anywhere in a drizzle condition tree. */
function conditionColumns(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === 'string' && 'columnType' in obj) acc.push(obj.name);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionColumns(c, acc);
  return acc;
}

/** Every bound value in a drizzle condition tree, flattened. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) conditionValues(n, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) {
    if (Array.isArray(obj.value)) acc.push(...obj.value);
    else acc.push(obj.value);
  }
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) {
    for (const c of chunks) {
      if (c === null || typeof c !== 'object') acc.push(c);
      else conditionValues(c, acc);
    }
  }
  return acc;
}

/** A task queue owing a step to these tasks and no START to any. */
const owesSteps = (...taskIds: string[]) => ({
  steps: new Set(taskIds),
  starts: new Set<string>(),
});

/** Deps for the failed-row path and the two other candidate sets, which these cases never reach. */
const noLostWork = {
  failTask: async () => false,
  enqueueStart: async () => undefined,
  queuedInvocationIds: async () => new Set<string>(),
};

interface RecordedUpdate {
  table: string;
  set: Record<string, unknown>;
  where: unknown;
}

interface Candidate {
  taskId: string;
  userId: string;
  stepId: string;
  round: number;
  epoch: number;
  rowId?: string | null;
  rowStatus?: string | null;
  rowError?: string | null;
}

/** One SELECT returning `candidates` verbatim, then a fenceResults-driven `transaction()` (the
 *  fence itself is exercised for real by the smoke test) and a plain `update()` for the hand-back
 *  write on a failed enqueue. */
function makeDb(
  candidates: Candidate[],
  recorded: RecordedUpdate[],
  fenceResults?: ({ epoch: number } | null)[],
): Database {
  let fenceCall = 0;
  const db = {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({
        leftJoin: (_table2: unknown, _cond: unknown) => ({
          where: (_cond2: unknown) => Promise.resolve(candidates),
        }),
        // No task waiting to start and no parked step here; the smoke covers both.
        innerJoin: () => ({ where: () => Promise.resolve([]) }),
        where: () => Promise.resolve([]),
      }),
    }),
    transaction: async (_fn: (tx: unknown) => unknown) => {
      // fenceResults may legitimately hold `null`, which ?? would treat as "not provided".
      const result = fenceResults
        ? fenceResults[fenceCall]
        : { epoch: candidates[fenceCall]!.epoch + 1 };
      fenceCall++;
      return result;
    },
    update: (table: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          recorded.push({ table: tableNameOf(table), set: v, where: cond });
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
  return db as unknown as Database;
}

/** Runs the candidates SELECT against an empty result and captures its LEFT JOIN and WHERE, so a
 *  test can assert the query's shape; the real join/filter semantics are exercised by the smoke. */
async function captureQuery(): Promise<{ joinCond: unknown; whereCond: unknown }> {
  let joinCond: unknown;
  let whereCond: unknown;
  const db = {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({
        leftJoin: (_table2: unknown, cond: unknown) => {
          joinCond = cond;
          return {
            where: (cond2: unknown) => {
              whereCond = cond2;
              return Promise.resolve([]);
            },
          };
        },
        innerJoin: () => ({ where: () => Promise.resolve([]) }),
        where: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Database;
  await redriveStalledTasks(
    db,
    {
      enqueueAdvance: async () => undefined,
      queuedTaskJobs: async () => owesSteps(),
      ...noLostWork,
    },
    { staleMs: 300_000 },
  );
  return { joinCond, whereCond };
}

describe('redriveStalledTasks', () => {
  it('re-drives a pending current row with no job at the bumped epoch', async () => {
    const recorded: RecordedUpdate[] = [];
    const candidate: Candidate = {
      taskId: 'task-1',
      userId: 'user-1',
      stepId: 'step-a',
      round: 0,
      epoch: 3,
    };
    const db = makeDb([candidate], recorded);
    const advances: { taskId: string; stepId: string; round: number; epoch: number }[] = [];
    const redriven = await redriveStalledTasks(
      db,
      {
        enqueueAdvance: async (taskId, _userId, stepId, round, epoch) => {
          advances.push({ taskId, stepId, round, epoch });
        },
        queuedTaskJobs: async () => owesSteps(),
        ...noLostWork,
      },
      { staleMs: 300_000 },
    );
    expect(redriven).toBe(1);
    expect(advances).toEqual([{ taskId: 'task-1', stepId: 'step-a', round: 0, epoch: 4 }]);
    expect(recorded).toEqual([]);
  });

  it('re-drives a task whose current step row does not exist yet', async () => {
    // The LEFT JOIN keys a task to its own current (step_id, round); a hand-off pointing at a
    // step never created yet leaves that join unmatched, which isNull(task_steps.id) admits.
    const { joinCond, whereCond } = await captureQuery();
    expect(conditionColumns(joinCond)).toEqual(
      expect.arrayContaining(['task_id', 'step_id', 'round']),
    );
    expect(conditionColumns(whereCond)).toContain('id');

    const recorded: RecordedUpdate[] = [];
    const candidate: Candidate = {
      taskId: 'task-2',
      userId: 'user-2',
      stepId: 'not-created-yet',
      round: 0,
      epoch: 7,
    };
    const db = makeDb([candidate], recorded);
    const advances: { taskId: string; epoch: number }[] = [];
    const redriven = await redriveStalledTasks(
      db,
      {
        enqueueAdvance: async (taskId, _userId, _stepId, _round, epoch) => {
          advances.push({ taskId, epoch });
        },
        queuedTaskJobs: async () => owesSteps(),
        ...noLostWork,
      },
      { staleMs: 300_000 },
    );
    expect(redriven).toBe(1);
    expect(advances).toEqual([{ taskId: 'task-2', epoch: 8 }]);
  });

  it('excludes a step already parked (waiting_started_at set) from the candidates query', async () => {
    const { whereCond } = await captureQuery();
    const columns = conditionColumns(whereCond);
    expect(columns).toContain('waiting_started_at');
    expect(columns).toEqual(expect.arrayContaining(['status', 'current_step_id', 'updated_at']));
    expect(conditionValues(whereCond)).toEqual(expect.arrayContaining(['running', 'pending']));
  });

  it('skips a task the task queue still owes a job', async () => {
    const recorded: RecordedUpdate[] = [];
    const candidate: Candidate = {
      taskId: 'task-1',
      userId: 'user-1',
      stepId: 'step-a',
      round: 0,
      epoch: 3,
    };
    const db = makeDb([candidate], recorded);
    const advances: unknown[] = [];
    const redriven = await redriveStalledTasks(
      db,
      {
        enqueueAdvance: async (...args) => {
          advances.push(args);
        },
        queuedTaskJobs: async () => owesSteps('task-1'),
        ...noLostWork,
      },
      { staleMs: 300_000 },
    );
    expect(redriven).toBe(0);
    expect(advances).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('skips a candidate whose fence no longer matches what this pass read', async () => {
    const recorded: RecordedUpdate[] = [];
    const candidate: Candidate = {
      taskId: 'task-1',
      userId: 'user-1',
      stepId: 'step-a',
      round: 0,
      epoch: 3,
    };
    const db = makeDb([candidate], recorded, [null]);
    const advances: unknown[] = [];
    const redriven = await redriveStalledTasks(
      db,
      {
        enqueueAdvance: async (...args) => {
          advances.push(args);
        },
        queuedTaskJobs: async () => owesSteps(),
        ...noLostWork,
      },
      { staleMs: 300_000 },
    );
    expect(redriven).toBe(0);
    expect(advances).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('hands the epoch back when the enqueue keeps failing, and continues with the next candidate', async () => {
    const recorded: RecordedUpdate[] = [];
    const failing: Candidate = {
      taskId: 'task-1',
      userId: 'user-1',
      stepId: 'step-a',
      round: 0,
      epoch: 3,
    };
    const ok: Candidate = {
      taskId: 'task-2',
      userId: 'user-2',
      stepId: 'step-b',
      round: 1,
      epoch: 5,
    };
    const db = makeDb([failing, ok], recorded, [{ epoch: 4 }, { epoch: 6 }]);
    const advances: { taskId: string; epoch: number }[] = [];
    const redriven = await redriveStalledTasks(
      db,
      {
        enqueueAdvance: async (taskId, _userId, _stepId, _round, epoch) => {
          if (taskId === 'task-1') throw new Error('redis blinked');
          advances.push({ taskId, epoch });
        },
        queuedTaskJobs: async () => owesSteps(),
        ...noLostWork,
        redriveRetryDelaysMs: [0, 0],
      },
      { staleMs: 300_000 },
    );
    expect(redriven).toBe(1);
    expect(advances).toEqual([{ taskId: 'task-2', epoch: 6 }]);
    // The failed candidate's epoch is handed back to what this pass read, not left at the bump.
    const handBack = recorded.find((u) => u.table === 'tasks' && u.set.orchestrationEpoch === 3);
    expect(handBack).toBeDefined();
    expect(conditionValues(handBack!.where)).toEqual(expect.arrayContaining(['task-1', 4]));
  });

  it('re-drives nothing when the task queue cannot be read', async () => {
    const recorded: RecordedUpdate[] = [];
    const candidate: Candidate = {
      taskId: 'task-1',
      userId: 'user-1',
      stepId: 'step-a',
      round: 0,
      epoch: 3,
    };
    const db = makeDb([candidate], recorded);
    const redriven = await redriveStalledTasks(
      db,
      { enqueueAdvance: async () => undefined, queuedTaskJobs: async () => null, ...noLostWork },
      { staleMs: 300_000 },
    );
    expect(redriven).toBe(0);
    expect(recorded).toEqual([]);
  });
});

describe('a running task whose current step failed', () => {
  it('is failed at its epoch with the step error, and nothing is queued for it', async () => {
    const recorded: RecordedUpdate[] = [];
    const candidate: Candidate = {
      taskId: 'task-1',
      userId: 'user-1',
      stepId: 'step-a',
      round: 0,
      epoch: 3,
      rowId: 'row-1',
      rowStatus: 'failed',
      rowError: 'cli invocation failed: boom',
    };
    const db = makeDb([candidate], recorded);
    const failed: FailedStep[] = [];
    const advances: unknown[] = [];
    const redriven = await redriveStalledTasks(
      db,
      {
        enqueueAdvance: async (...args) => {
          advances.push(args);
        },
        queuedTaskJobs: async () => owesSteps(),
        ...noLostWork,
        failTask: async (_db, f) => {
          failed.push(f);
          return true;
        },
      },
      { staleMs: 300_000 },
    );
    expect(redriven).toBe(1);
    expect(failed).toEqual([
      {
        taskId: 'task-1',
        epoch: 3,
        stepId: 'step-a',
        rowId: 'row-1',
        message: 'cli invocation failed: boom',
      },
    ]);
    expect(advances).toEqual([]);
  });

  it('fails it through the step hand-off, and only while it is still running', async () => {
    const db = {} as Database;
    await defaultDeps.failTask(db, {
      taskId: 'task-1',
      epoch: 3,
      stepId: 'step-a',
      rowId: 'row-1',
      message: 'boom',
    });
    expect(stubs.finishFailedStep).toHaveBeenCalledWith(
      db,
      { taskId: 'task-1', orchestrationEpoch: 3 },
      'step-a',
      { id: 'row-1' },
      'boom',
      ['running'],
    );
  });
});

describe('taskQueueOwed', () => {
  it('owes a step for every job but a START, and records the STARTs apart', () => {
    const owed = taskQueueOwed([
      { name: 'advance-step', data: { taskId: 'advancing' } },
      { name: 'cancel-task', data: { taskId: 'cancelling' } },
      // A START a dead worker left active: after its claim the task is running, and START refuses it.
      { name: 'start-task', data: { taskId: 'claimed' } },
      { name: 'cleanup-repo-rag', data: { repositoryId: 'repo-1' } },
      undefined,
    ]);
    expect([...owed.steps].sort()).toEqual(['advancing', 'cancelling']);
    expect([...owed.starts]).toEqual(['claimed']);
  });
});
