import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const stubs = vi.hoisted(() => ({ finishFailedStep: vi.fn(async (..._args: unknown[]) => true) }));

vi.mock('../src/queues/task-queue.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  finishFailedStep: stubs.finishFailedStep,
}));

import {
  defaultDeps,
  redrivableRow,
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
  taskStatus?: string;
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

  it('reads the park marker and the row heartbeat in the candidates query', async () => {
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

describe('redrivableRow', () => {
  const cutoff = new Date('2026-02-01T00:10:00Z');
  const idle = new Date('2026-02-01T00:00:00Z');
  const takes = createFakeDb({ taskSteps: schema.taskSteps }).compileWhere(
    schema.taskSteps,
    redrivableRow(cutoff),
  );
  const row = (status: string, over: Record<string, unknown> = {}) => ({
    status,
    waitingStartedAt: null,
    updatedAt: idle,
    ...over,
  });

  it('takes an answered form, whose advance the answer route never queued', () => {
    expect(takes(row('waiting_form'))).toBe(true);
  });

  it('leaves a parked form to the person it waits on', () => {
    expect(takes(row('waiting_form', { waitingStartedAt: idle }))).toBe(false);
  });

  it('leaves an answer written since the cutoff to its own advance', () => {
    expect(takes(row('waiting_form', { updatedAt: new Date('2026-02-01T00:20:00Z') }))).toBe(false);
  });

  it.each(['pending', 'done', 'skipped'])('still takes a %s row', (status) => {
    expect(takes(row(status))).toBe(true);
  });

  it.each(['running', 'waiting_cli', 'failed'])('still leaves a %s row', (status) => {
    expect(takes(row(status))).toBe(false);
  });

  it('still leaves a parked pending row', () => {
    expect(takes(row('pending', { waitingStartedAt: idle }))).toBe(false);
  });
});

describe('the tasks the sweep takes, by task status and current row', () => {
  const idle = new Date(Date.now() - 10 * 60_000);

  const columnsOf = (prefix: string, table: PgTable) =>
    Object.entries(getTableColumns(table)).map(([key, col]) => [`${prefix}.${key}`, col]);
  /** The candidates query's LEFT JOIN as one table, so the fake db can run its condition over a task and its row. */
  const joined = {
    [Symbol.for('drizzle:Name')]: 'task_current_step',
    [Symbol.for('drizzle:Columns')]: Object.fromEntries([
      ...columnsOf('task', schema.tasks),
      ...columnsOf('step', schema.taskSteps),
    ]),
  } as unknown as PgTable;

  interface Seed {
    taskId: string;
    taskStatus: string;
    taskUpdatedAt: Date;
    row: { status: string; waitingStartedAt?: Date | null; updatedAt?: Date } | null;
    deadAt?: Date;
  }
  const seed = (
    taskId: string,
    taskStatus: string,
    row: Seed['row'],
    taskUpdatedAt = idle,
  ): Seed => ({ taskId, taskStatus, taskUpdatedAt, row });

  /** What the candidates SELECT returns over these tasks: its own condition, run by the fake db. */
  async function candidatesAmong(seeds: Seed[]): Promise<Candidate[]> {
    const { whereCond } = await captureQuery();
    const takes = createFakeDb({ taskSteps: schema.taskSteps }).compileWhere(joined, whereCond);
    return seeds.flatMap((s) => {
      const rowId = s.row ? `row-${s.taskId}` : null;
      const rowStatus = s.row?.status ?? null;
      const taken = takes({
        'task.status': s.taskStatus,
        'task.deadAt': s.deadAt ?? null,
        'task.currentStepId': 'step-a',
        'task.updatedAt': s.taskUpdatedAt,
        'step.id': rowId,
        'step.status': rowStatus,
        'step.waitingStartedAt': s.row?.waitingStartedAt ?? null,
        'step.updatedAt': s.row ? (s.row.updatedAt ?? idle) : null,
      });
      return taken
        ? [
            {
              taskId: s.taskId,
              userId: 'user-1',
              stepId: 'step-a',
              round: 0,
              epoch: 3,
              taskStatus: s.taskStatus,
              rowId,
              rowStatus,
              rowWaitingStartedAt: s.row?.waitingStartedAt ?? null,
            },
          ]
        : [];
    });
  }

  async function advancedBy(
    seeds: Seed[],
    owed: string[] = [],
    starts: string[] = [],
    held = false,
  ) {
    const advances: { taskId: string; epoch: number }[] = [];
    await redriveStalledTasks(
      makeDb(await candidatesAmong(seeds), []),
      {
        enqueueAdvance: async (taskId, _userId, _stepId, _round, epoch) => {
          advances.push({ taskId, epoch });
        },
        queuedTaskJobs: async () => ({ ...owesSteps(...owed), starts: new Set(starts) }),
        stepHeld: () => held,
        ...noLostWork,
      },
      { staleMs: 300_000 },
    );
    return advances;
  }

  const answered = { status: 'waiting_form' };

  it('re-drives a waiting_user task whose current form was answered, once at the bumped epoch', async () => {
    expect(await advancedBy([seed('task', 'waiting_user', answered)])).toEqual([
      { taskId: 'task', epoch: 4 },
    ]);
  });

  it('leaves a waiting_user task whose current form is parked to the person it waits on', async () => {
    const parked = { ...answered, waitingStartedAt: idle };
    expect(await advancedBy([seed('task', 'waiting_user', parked)])).toEqual([]);
  });

  it('leaves an answered form the task queue still owes a job', async () => {
    expect(await advancedBy([seed('task', 'waiting_user', answered)], ['task'])).toEqual([]);
  });

  it('leaves an answer written since the cutoff to its own advance', async () => {
    const written = { ...answered, updatedAt: new Date() };
    expect(await advancedBy([seed('task', 'waiting_user', written)])).toEqual([]);
  });

  it('leaves a task that moved since the cutoff to the pass that moved it', async () => {
    expect(await advancedBy([seed('task', 'waiting_user', answered, new Date())])).toEqual([]);
  });

  it.each(['pending', 'running', 'waiting_cli', 'done', 'skipped', 'failed'])(
    'leaves a waiting_user task on a %s current row',
    async (status) => {
      expect(await advancedBy([seed('task', 'waiting_user', { status })])).toEqual([]);
    },
  );

  it('leaves a waiting_user task with no current row', async () => {
    expect(await advancedBy([seed('task', 'waiting_user', null)])).toEqual([]);
  });

  it.each(['created', 'queued', 'paused', 'completed', 'failed', 'cancelled'])(
    'leaves a %s task with an answered form',
    async (taskStatus) => {
      expect(await advancedBy([seed('task', taskStatus, answered)])).toEqual([]);
    },
  );

  it.each([
    ['an answered form', answered],
    ['a pending row', { status: 'pending' }],
    ['a finished row', { status: 'done' }],
    ['no current row', null],
  ])('still re-drives a running task on %s', async (_name, row) => {
    expect(await advancedBy([seed('task', 'running', row)])).toEqual([
      { taskId: 'task', epoch: 4 },
    ]);
  });

  it('still leaves a running task on a parked form', async () => {
    const parked = { ...answered, waitingStartedAt: idle };
    expect(await advancedBy([seed('task', 'running', parked)])).toEqual([]);
  });

  describe('a running task on a parked pending row, whose poll chain rewrites the row on every tick', () => {
    const park = { status: 'pending', waitingStartedAt: idle };

    it('re-drives it once the row heartbeat is older than the cutoff', async () => {
      expect(await advancedBy([seed('task', 'running', park)])).toEqual([
        { taskId: 'task', epoch: 4 },
      ]);
    });

    it('leaves it to its chain while the heartbeat is newer, whatever the task row says', async () => {
      const ticking = { ...park, updatedAt: new Date() };
      expect(await advancedBy([seed('task', 'running', ticking)])).toEqual([]);
    });

    it('leaves it when the task queue still owes the task a job', async () => {
      expect(await advancedBy([seed('task', 'running', park)], ['task'])).toEqual([]);
    });

    it('leaves it to a START the queue holds for the task', async () => {
      expect(await advancedBy([seed('task', 'running', park)], [], ['task'])).toEqual([]);
    });

    it('still re-drives an unparked pending row beside a queued START', async () => {
      expect(
        await advancedBy([seed('task', 'running', { status: 'pending' })], [], ['task']),
      ).toEqual([{ taskId: 'task', epoch: 4 }]);
    });

    it.each(['waiting_user', 'waiting_pr'])('leaves a %s task on it', async (taskStatus) => {
      expect(await advancedBy([seed('task', taskStatus, park)])).toEqual([]);
    });
  });

  describe('a running task on a running row, re-opened by a Resume whose advance never reached the queue', () => {
    const reopened = { status: 'running' };

    it('re-drives it once the row has been idle longer than the cutoff', async () => {
      expect(await advancedBy([seed('task', 'running', reopened)])).toEqual([
        { taskId: 'task', epoch: 4 },
      ]);
    });

    it('leaves a row written since the cutoff to the pass that wrote it', async () => {
      const written = { ...reopened, updatedAt: new Date() };
      expect(await advancedBy([seed('task', 'running', written)])).toEqual([]);
    });

    it('leaves it when the task queue still owes the task a job', async () => {
      expect(await advancedBy([seed('task', 'running', reopened)], ['task'])).toEqual([]);
    });

    it('leaves it to a START the queue holds for the task, which runs the first step itself', async () => {
      expect(await advancedBy([seed('task', 'running', reopened)], [], ['task'])).toEqual([]);
    });
  });

  it.each([
    ['a running row', { status: 'running' }],
    ['a parked row', { status: 'pending', waitingStartedAt: idle }],
    ['a pending row', { status: 'pending' }],
    ['a finished row', { status: 'done' }],
    ['no current row', null],
  ])('leaves a step a pass of this process is on, on %s', async (_name, row) => {
    expect(await advancedBy([seed('task', 'running', row)], [], [], true)).toEqual([]);
    expect(await advancedBy([seed('task', 'running', row)], [], [], false)).toHaveLength(1);
  });

  it('still leaves a running task that moved since the cutoff to the pass that moved it', async () => {
    expect(await advancedBy([seed('task', 'running', answered, new Date())])).toEqual([]);
  });

  describe('a waiting_pr task, which the pull-request poller rewrites every few minutes', () => {
    const polled = new Date();

    it('re-drives a task whose current form was answered, once at the bumped epoch, whatever the poller last wrote', async () => {
      expect(await advancedBy([seed('task', 'waiting_pr', answered, polled)])).toEqual([
        { taskId: 'task', epoch: 4 },
      ]);
    });

    it('re-drives it the same when the task itself has been idle', async () => {
      expect(await advancedBy([seed('task', 'waiting_pr', answered)])).toEqual([
        { taskId: 'task', epoch: 4 },
      ]);
    });

    it('leaves a task whose current form is parked to the person it waits on', async () => {
      const parked = { ...answered, waitingStartedAt: idle };
      expect(await advancedBy([seed('task', 'waiting_pr', parked, polled)])).toEqual([]);
    });

    it('leaves an answered form the task queue still owes a job', async () => {
      expect(await advancedBy([seed('task', 'waiting_pr', answered, polled)], ['task'])).toEqual(
        [],
      );
    });

    it('leaves an answer written since the cutoff to its own advance', async () => {
      const written = { ...answered, updatedAt: new Date() };
      expect(await advancedBy([seed('task', 'waiting_pr', written, polled)])).toEqual([]);
      expect(await advancedBy([seed('task', 'waiting_pr', written)])).toEqual([]);
    });

    it.each(['pending', 'running', 'waiting_cli', 'done', 'skipped', 'failed'])(
      'leaves a task on a %s current row',
      async (status) => {
        expect(await advancedBy([seed('task', 'waiting_pr', { status }, polled)])).toEqual([]);
        expect(await advancedBy([seed('task', 'waiting_pr', { status })])).toEqual([]);
      },
    );

    it('leaves a task with no current row', async () => {
      expect(await advancedBy([seed('task', 'waiting_pr', null, polled)])).toEqual([]);
      expect(await advancedBy([seed('task', 'waiting_pr', null)])).toEqual([]);
    });

    it('leaves a dead task to its revival', async () => {
      const dead = { ...seed('task', 'waiting_pr', answered, polled), deadAt: new Date() };
      expect(await advancedBy([dead])).toEqual([]);
    });
  });

  describe('an answered form whose advance the queue drops without touching its row', () => {
    const TASK = '00000000-0000-4000-8000-000000000001';
    const t0 = new Date('2026-02-01T12:00:00Z');
    const after = (ms: number) => new Date(t0.getTime() + ms);
    const fake = createFakeDb({ taskSteps: schema.taskSteps });

    interface World {
      taskStatus: string;
      taskUpdatedAt: Date;
      epoch: number;
      row: { status: string; waitingStartedAt: Date | null; updatedAt: Date };
    }
    const world = (taskStatus: string): World => ({
      taskStatus,
      taskUpdatedAt: after(-10 * 60_000),
      epoch: 3,
      row: { status: 'waiting_form', waitingStartedAt: null, updatedAt: after(-10 * 60_000) },
    });

    /** Sweeps one task: its candidates SELECT runs the real condition and its fence applies the writes. */
    function sweeper(w: World) {
      const ops: string[] = [];
      const epochs: number[] = [];
      const pass = async (at: Date) => {
        vi.setSystemTime(at);
        const { whereCond } = await captureQuery();
        const takes = fake.compileWhere(joined, whereCond);
        const rowIs = (cond: unknown) => {
          const matches = fake.compileWhere(schema.taskSteps, cond);
          return matches({ taskId: TASK, stepId: 'step-a', round: 0, ...w.row });
        };
        const tx = {
          select: () => ({
            from: (table: unknown) => ({
              where: (cond: unknown) => ({
                for: async () => {
                  ops.push(`lock ${tableNameOf(table)}`);
                  return tableNameOf(table) === 'task_steps' && !rowIs(cond) ? [] : [{ id: 'x' }];
                },
              }),
            }),
          }),
          update: (table: unknown) => ({
            set: (v: Record<string, unknown>) => ({
              where: (cond: unknown) => {
                ops.push(`update ${tableNameOf(table)}`);
                if (tableNameOf(table) === 'task_steps') {
                  if (rowIs(cond)) w.row.updatedAt = v.updatedAt as Date;
                  return Promise.resolve(undefined);
                }
                w.epoch += 1;
                w.taskUpdatedAt = v.updatedAt as Date;
                return { returning: async () => [{ epoch: w.epoch }] };
              },
            }),
          }),
        };
        const db = {
          select: () => ({
            from: () => ({
              leftJoin: () => ({
                where: async () =>
                  takes({
                    'task.status': w.taskStatus,
                    'task.deadAt': null,
                    'task.currentStepId': 'step-a',
                    'task.updatedAt': w.taskUpdatedAt,
                    'step.id': 'row-1',
                    'step.status': w.row.status,
                    'step.waitingStartedAt': w.row.waitingStartedAt,
                    'step.updatedAt': w.row.updatedAt,
                  })
                    ? [
                        {
                          taskId: TASK,
                          userId: 'user-1',
                          stepId: 'step-a',
                          round: 0,
                          epoch: w.epoch,
                          taskStatus: w.taskStatus,
                          rowId: 'row-1',
                          rowStatus: w.row.status,
                        },
                      ]
                    : [],
              }),
              innerJoin: () => ({ where: async () => [] }),
              where: async () => [],
            }),
          }),
          transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
        } as unknown as Database;
        await redriveStalledTasks(
          db,
          {
            enqueueAdvance: async (_taskId, _userId, _stepId, _round, epoch) => {
              epochs.push(epoch);
            },
            queuedTaskJobs: async () => owesSteps(),
            ...noLostWork,
          },
          { staleMs: 300_000 },
        );
      };
      return { ops, epochs, pass };
    }

    beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
    afterEach(() => vi.useRealTimers());

    it.each(['waiting_user', 'waiting_pr'])(
      'touches the row of a %s task it re-drives, locked before the task, in the same transaction',
      async (status) => {
        const w = world(status);
        const s = sweeper(w);
        await s.pass(t0);
        expect(s.epochs).toEqual([4]);
        expect(s.ops).toEqual([
          'lock task_steps',
          'lock tasks',
          'update tasks',
          'update task_steps',
        ]);
        expect(w.row.updatedAt).toEqual(t0);
      },
    );

    it.each(['waiting_user', 'waiting_pr'])(
      'leaves a %s answered form a full cutoff after each re-drive, as its advance is dropped',
      async (status) => {
        const w = world(status);
        const s = sweeper(w);
        await s.pass(t0);
        for (const ms of [60_000, 240_000, 300_000]) {
          // The pull-request poller writes the task before every pass; a dropped advance writes nothing.
          if (status === 'waiting_pr') w.taskUpdatedAt = after(ms);
          await s.pass(after(ms));
        }
        expect(s.epochs).toEqual([4]);
        if (status === 'waiting_pr') w.taskUpdatedAt = after(301_000);
        await s.pass(after(301_000));
        expect(s.epochs).toEqual([4, 5]);
      },
    );

    it('leaves the row of a running task it re-drives as it was', async () => {
      const w = world('running');
      const s = sweeper(w);
      await s.pass(t0);
      expect(s.epochs).toEqual([4]);
      expect(s.ops).toEqual(['lock tasks', 'update tasks']);
      expect(w.row.updatedAt).toEqual(after(-10 * 60_000));
    });
  });
});
