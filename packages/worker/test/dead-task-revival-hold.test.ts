import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, logger, type WorkflowType } from '@haive/shared';
import {
  DEAD_TASK_REVIVE_RETRY_MS,
  retryHeldRevivals,
  reviveDeadTask,
  reviveDeadTasks,
  type DeadTaskBootDeps,
  type DeadTaskView,
} from '../src/queues/dead-task-boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';

vi.mock('../src/db.js', () => ({
  getDb: vi.fn(() => {
    throw new Error('no database in this test');
  }),
}));

const USER = '00000000-0000-4000-8000-0000000000a1';
const TYPE = 'fnf135_revival_hold';
const A = 'fnf135-hold-a';
const B = 'fnf135-hold-b';
const DEAD_AT = new Date('2026-10-14T08:00:00.000Z');
const FENCE = 'select pg_advisory_xact_lock_shared(hashtextextended($1, 0))';
const READS_STATE = 'reads the state';
const uuid = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;

for (const [stepId, index] of [
  [A, 1],
  [B, 2],
] as const) {
  stepRegistry.register({
    metadata: {
      id: stepId,
      workflowType: TYPE as WorkflowType,
      index,
      title: stepId,
      description: 'dead-task revival hold test stub',
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    form() {
      return { title: stepId, fields: [] };
    },
    async apply() {
      return {};
    },
  });
}

/** Dead tasks whose run list resolves; `log` lists what each transaction sends, in order. */
function setup(initialState: string | Error = 'normal') {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    taskTypeDefinitions: schema.taskTypeDefinitions,
  });
  fake.insert(schema.taskTypeDefinitions, {
    slug: TYPE,
    displayName: TYPE,
    runListStrategy: 'static',
    source: 'test',
  });
  const log: string[] = [];
  const dialect = new PgDialect();
  let failFence = false;
  let failSelects = 0;
  const db = {
    ...fake.db,
    select: (...args: Parameters<typeof fake.db.select>) => {
      if (failSelects > 0) {
        failSelects -= 1;
        throw new Error('database went away');
      }
      return fake.db.select(...args);
    },
    transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fake.db.transaction((tx) =>
        fn({
          ...tx,
          select: (...args: Parameters<typeof tx.select>) => ({
            from: (table: Parameters<ReturnType<typeof tx.select>['from']>[0]) => {
              const query = tx.select(...args).from(table);
              const lock = query.for.bind(query);
              return Object.assign(query, {
                for: (...rest: Parameters<typeof lock>) => {
                  log.push(`locks ${getTableName(table)}`);
                  return lock(...rest);
                },
              });
            },
          }),
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            const text = dialect.sqlToQuery(query as never).sql;
            log.push(text);
            if (failFence && text === FENCE) throw new Error('connection lost');
            return tx.execute(query);
          },
        }),
      ),
  } as unknown as Database;
  fake.hooks.beforeUpdate = (table) => {
    log.push(`updates ${getTableName(table)}`);
  };
  fake.hooks.beforeInsert = (table) => {
    log.push(`inserts ${getTableName(table)}`);
  };
  let gate: Promise<void> | null = null;
  vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
    log.push(READS_STATE);
    await gate;
    if (initialState instanceof Error) throw initialState;
    return initialState;
  });
  const sent: string[] = [];
  const deps: DeadTaskBootDeps = {
    enqueueStart: async (taskId) => {
      sent.push(`start ${taskId}`);
    },
    enqueueAdvance: async (taskId) => {
      sent.push(`advance ${taskId}`);
    },
    redriveRetryDelaysMs: [],
  };
  const dead = (n: number, over: Record<string, unknown> = {}) =>
    fake.insert(schema.tasks, {
      id: uuid(n),
      userId: USER,
      type: TYPE,
      title: `dead ${n}`,
      status: 'queued',
      orchestrationEpoch: 3,
      currentStepId: null,
      currentRound: 0,
      runListSnapshot: [A, B],
      deadAt: DEAD_AT,
      deadReason: 'a step it names is not registered',
      ...over,
    });
  const task = (n: number) => fake.rows(schema.tasks).find((r) => r.id === uuid(n))!;
  const view = (n: number): DeadTaskView => ({
    id: uuid(n),
    userId: USER,
    epoch: 3,
    currentStepId: null,
    currentRound: 0,
    deadAt: DEAD_AT,
    deadReason: 'a step it names is not registered',
  });
  const untouched = () => {
    expect(
      fake.rows(schema.tasks).every((r) => r.deadAt !== null && r.orchestrationEpoch === 3),
    ).toBe(true);
    expect(fake.rows(schema.taskEvents)).toEqual([]);
    expect(sent).toEqual([]);
  };
  return {
    fake,
    db,
    log,
    sent,
    deps,
    dead,
    task,
    view,
    untouched,
    holdStateReads: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return () => release();
    },
    failFence: () => {
      failFence = true;
    },
    failSelects: (n: number) => {
      failSelects = n;
    },
    fences: () => log.filter((entry) => entry === FENCE).length,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reviveDeadTask while new work is held', () => {
  it.each(['draining', 'maintenance'])(
    'takes the shared fence, reads the state under it, and writes and queues nothing while the system is %s',
    async (state) => {
      const t = setup(state);
      t.dead(1);

      await expect(reviveDeadTask(t.db, t.view(1), t.deps)).resolves.toBe('held');

      expect(t.log).toEqual([FENCE, READS_STATE]);
      expect(t.task(1)).toMatchObject({ deadAt: DEAD_AT, orchestrationEpoch: 3 });
      t.untouched();
    },
  );

  it('takes the fence and reads the state before it locks the task row', async () => {
    const t = setup('normal');
    t.dead(1);

    // The fake db cannot run the write that follows the lock; the order of what precedes it is read.
    await reviveDeadTask(t.db, t.view(1), t.deps).catch(() => undefined);

    expect(t.log.slice(0, 3)).toEqual([FENCE, READS_STATE, 'locks tasks']);
  });

  it('reports the hold, and writes nothing, when the stored state cannot be read under the fence', async () => {
    const t = setup(new Error('redis went away'));
    t.dead(1);

    await expect(reviveDeadTask(t.db, t.view(1), t.deps)).resolves.toBe('held');

    expect(t.log).toEqual([FENCE, READS_STATE]);
    expect(t.task(1)).toMatchObject({ deadAt: DEAD_AT, orchestrationEpoch: 3 });
    t.untouched();
  });

  it('does not call a fence that fails to lock a hold', async () => {
    const t = setup('maintenance');
    t.dead(1);
    t.failFence();

    await expect(reviveDeadTask(t.db, t.view(1), t.deps)).rejects.toThrow('connection lost');

    expect(t.log).toEqual([FENCE]);
    t.untouched();
  });
});

describe('a pass over the dead tasks while new work is held', () => {
  it('holds back every task whose steps resolve, writes nothing, and says so once', async () => {
    const t = setup('maintenance');
    t.dead(1);
    t.dead(2);
    t.dead(3, { runListSnapshot: [A, 'module.fnf135.gone'] });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await expect(reviveDeadTasks(t.db, t.deps)).resolves.toEqual({ revived: 0, held: 2 });

    expect(t.log).toEqual([FENCE, READS_STATE, FENCE, READS_STATE]);
    t.untouched();
    const said = info.mock.calls.filter(
      ([fields]) => (fields as { held?: number })?.held !== undefined,
    );
    expect(said).toEqual([[expect.objectContaining({ held: 2 }), expect.any(String)]]);
  });

  it('says nothing when nothing is held back', async () => {
    const t = setup('maintenance');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await expect(reviveDeadTasks(t.db, t.deps)).resolves.toEqual({ revived: 0, held: 0 });

    expect(info).not.toHaveBeenCalled();
    expect(t.log).toEqual([]);
  });
});

describe('retryHeldRevivals', () => {
  it('runs a pass every 30 s while a pass holds something back, and none once a pass holds nothing back', async () => {
    vi.useFakeTimers();
    const t = setup('maintenance');
    t.dead(1);
    retryHeldRevivals(t.db, t.deps);

    expect(DEAD_TASK_REVIVE_RETRY_MS).toBe(30_000);
    await vi.advanceTimersByTimeAsync(DEAD_TASK_REVIVE_RETRY_MS - 1);
    expect(t.fences()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fences()).toBe(1);
    await vi.advanceTimersByTimeAsync(DEAD_TASK_REVIVE_RETRY_MS);
    expect(t.fences()).toBe(2);
    expect(t.task(1)).toMatchObject({ deadAt: DEAD_AT, orchestrationEpoch: 3 });
    expect(vi.getTimerCount()).toBe(1);

    t.fake.patch(schema.tasks, uuid(1), { status: 'cancelled' });
    await vi.advanceTimersByTimeAsync(DEAD_TASK_REVIVE_RETRY_MS);
    expect(vi.getTimerCount()).toBe(0);

    t.dead(2);
    await vi.advanceTimersByTimeAsync(4 * DEAD_TASK_REVIVE_RETRY_MS);
    expect(t.fences()).toBe(2);
    expect(t.sent).toEqual([]);
  });

  it('goes on after a pass that fails, which is not a pass that held nothing back', async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const t = setup('maintenance');
    t.dead(1);
    t.failSelects(1);
    retryHeldRevivals(t.db, t.deps);

    await vi.advanceTimersByTimeAsync(DEAD_TASK_REVIVE_RETRY_MS);
    expect(t.fences()).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DEAD_TASK_REVIVE_RETRY_MS);
    expect(t.fences()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('starts no pass while the last one is still running', async () => {
    vi.useFakeTimers();
    const t = setup('maintenance');
    t.dead(1);
    const release = t.holdStateReads();
    retryHeldRevivals(t.db, t.deps);

    await vi.advanceTimersByTimeAsync(3 * DEAD_TASK_REVIVE_RETRY_MS);
    expect(t.fences()).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(DEAD_TASK_REVIVE_RETRY_MS);
    expect(t.fences()).toBe(2);
  });

  it('runs no pass after it is stopped', async () => {
    vi.useFakeTimers();
    const t = setup('maintenance');
    t.dead(1);
    const stop = retryHeldRevivals(t.db, t.deps);

    stop();
    await vi.advanceTimersByTimeAsync(3 * DEAD_TASK_REVIVE_RETRY_MS);

    expect(t.fences()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
