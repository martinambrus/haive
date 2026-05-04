import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';

/** Recorded shape of fluent drizzle calls. The fake tx below intercepts
 *  select/from/where + update/set/where + insert/values and writes them
 *  here so the test can assert exact call arguments. */
interface Recorded {
  selectArgs: unknown;
  fromArg: unknown;
  whereArg: unknown;
  selectReturn: Array<{ id: string }>;
  updateCalls: Array<{ table: unknown; set: Record<string, unknown>; where: unknown }>;
  insertCalls: Array<{ table: unknown; values: Record<string, unknown> }>;
}

function makeFakeTx(selectReturn: Array<{ id: string }> = []): {
  tx: never;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    selectArgs: undefined,
    fromArg: undefined,
    whereArg: undefined,
    selectReturn,
    updateCalls: [],
    insertCalls: [],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    select: (cols: unknown) => ({
      from: (table: unknown) => ({
        where: async (clause: unknown) => {
          recorded.selectArgs = cols;
          recorded.fromArg = table;
          recorded.whereArg = clause;
          return selectReturn;
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (s: Record<string, unknown>) => ({
        where: async (w: unknown) => {
          recorded.updateCalls.push({ table, set: s, where: w });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        recorded.insertCalls.push({ table, values: v });
      },
    }),
  };
  return { tx: tx as never, recorded };
}

const queueAdd = vi.fn(async () => undefined);

vi.mock('../src/queues.js', () => ({
  getTaskQueue: () => ({ add: queueAdd }),
}));

const { cancelTaskRow, enqueueCancelJob, cancelOpenTasksForRepo } =
  await import('../src/lib/cancel-task.js');

beforeEach(() => {
  queueAdd.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cancelTaskRow', () => {
  it('updates status to cancelled and stamps completedAt + updatedAt', async () => {
    const fixedNow = new Date('2026-05-03T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const { tx, recorded } = makeFakeTx();
    await cancelTaskRow(tx, 'task-1', { by: 'user-1' });

    expect(recorded.updateCalls).toHaveLength(1);
    expect(recorded.updateCalls[0].table).toBe(schema.tasks);
    expect(recorded.updateCalls[0].set).toMatchObject({
      status: 'cancelled',
      completedAt: fixedNow,
      updatedAt: fixedNow,
    });
  });

  it('appends a task.cancelled event with by-user payload', async () => {
    const { tx, recorded } = makeFakeTx();
    await cancelTaskRow(tx, 'task-1', { by: 'user-1' });

    expect(recorded.insertCalls).toHaveLength(1);
    expect(recorded.insertCalls[0].table).toBe(schema.taskEvents);
    expect(recorded.insertCalls[0].values).toMatchObject({
      taskId: 'task-1',
      taskStepId: null,
      eventType: 'task.cancelled',
      payload: { by: 'user-1' },
    });
  });

  it('includes reason in the event payload when provided', async () => {
    const { tx, recorded } = makeFakeTx();
    await cancelTaskRow(tx, 'task-1', { by: 'user-1', reason: 'repository_deleted' });

    expect(recorded.insertCalls[0].values.payload).toEqual({
      by: 'user-1',
      reason: 'repository_deleted',
    });
  });

  it('runs update before insert (event references the cancelled task)', async () => {
    const { tx } = makeFakeTx();
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedTx: any = {
      update: (...args: unknown[]) => {
        order.push('update');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (tx as any).update(...args);
      },
      insert: (...args: unknown[]) => {
        order.push('insert');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (tx as any).insert(...args);
      },
    };
    await cancelTaskRow(wrappedTx as never, 'task-1', { by: 'user-1' });
    expect(order).toEqual(['update', 'insert']);
  });
});

describe('enqueueCancelJob', () => {
  it('adds a haive-task CANCEL job with idempotent retention settings', async () => {
    await enqueueCancelJob('task-1', 'user-1');
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      'cancel-task',
      { taskId: 'task-1', userId: 'user-1' },
      { removeOnComplete: 50, removeOnFail: 50 },
    );
  });
});

describe('cancelOpenTasksForRepo', () => {
  it('returns the list of cancelled tasks and calls cancelTaskRow for each', async () => {
    const open = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
    const { tx, recorded } = makeFakeTx(open);

    const result = await cancelOpenTasksForRepo(tx, 'repo-1', 'user-1');

    expect(result).toEqual(open);
    expect(recorded.updateCalls).toHaveLength(3);
    expect(recorded.insertCalls).toHaveLength(3);
    for (const call of recorded.updateCalls) {
      expect(call.set).toMatchObject({ status: 'cancelled' });
    }
    for (const call of recorded.insertCalls) {
      expect(call.values.payload).toEqual({
        by: 'user-1',
        reason: 'repository_deleted',
      });
    }
  });

  it('returns empty array and skips writes when no open tasks exist', async () => {
    const { tx, recorded } = makeFakeTx([]);
    const result = await cancelOpenTasksForRepo(tx, 'repo-1', 'user-1');

    expect(result).toEqual([]);
    expect(recorded.updateCalls).toEqual([]);
    expect(recorded.insertCalls).toEqual([]);
  });

  it('queries with the right column projection and table', async () => {
    const { tx, recorded } = makeFakeTx([{ id: 't1' }]);
    await cancelOpenTasksForRepo(tx, 'repo-1', 'user-1');
    // Only the id column is selected — we don't need anything else to drive
    // the cancel + enqueue path.
    expect(recorded.selectArgs).toEqual({ id: schema.tasks.id });
    expect(recorded.fromArg).toBe(schema.tasks);
  });
});
