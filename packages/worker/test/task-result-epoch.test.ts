import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import {
  handleResult,
  markTaskCompleted,
  setContainerCleanupRunner,
} from '../src/queues/task-queue.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

vi.mock('../src/db.js', () => ({
  getDb: vi.fn(() => {
    throw new Error('no database in this test');
  }),
}));

const STEP_ID = 'epoch-fence-step';
stepRegistry.register({
  metadata: {
    id: STEP_ID,
    workflowType: 'workflow',
    index: 0,
    title: 'epoch fence step',
    description: 'a step whose result is handed off',
    requiresCli: false,
  },
  async detect() {
    return {};
  },
  async apply() {
    return {};
  },
} as StepDefinition);

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

/** A task behind a db that records every statement it is sent. The epoch a read returns and the
 *  one a write is matched against can differ: that is a Retry landing between the two. A write
 *  that names no epoch lands whatever the task's is. A step row write carrying the ownership
 *  guard lands only while `rowStatus` is not `pending` or `skipped`; `selectRows` is what a read
 *  of the task's events answers. */
function taskDb(
  readEpoch: number,
  writeEpoch = readEpoch,
  opts: { rowStatus?: string; selectRows?: unknown[] } = {},
) {
  const statements: string[] = [];
  const events: unknown[] = [];
  const db = {
    query: {
      tasks: { findFirst: async () => ({ orchestrationEpoch: readEpoch }) },
    },
    update: (table: unknown) => {
      statements.push(`update ${tableNameOf(table)}`);
      return {
        set: () => ({
          where: (cond: unknown) => ({
            returning: async () => {
              const values = conditionValues(cond);
              if (tableNameOf(table) === 'task_steps') {
                const guarded = values.includes('pending') && values.includes('skipped');
                const taken = opts.rowStatus === 'pending' || opts.rowStatus === 'skipped';
                return guarded && taken ? [] : [{ id: 'ts-1' }];
              }
              const epochs = values.filter((v) => typeof v === 'number');
              return epochs.length > 0 && !epochs.includes(writeEpoch) ? [] : [{ id: 'task-1' }];
            },
          }),
        }),
      };
    },
    insert: (table: unknown) => {
      statements.push(`insert ${tableNameOf(table)}`);
      return {
        values: async (v: { eventType?: unknown }) => {
          events.push(v.eventType);
        },
      };
    },
    select: () => {
      statements.push('select');
      if (!opts.selectRows) throw new Error('this test reads nothing but the epoch');
      const rows = opts.selectRows;
      // Awaited directly by some reads and cut with .limit() by others, ordered or not.
      const result = {
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(res, rej),
        limit: async () => rows,
        orderBy: () => ({ limit: async () => rows }),
      };
      return { from: () => ({ where: () => result }) };
    },
  } as unknown as Database;
  return { db, statements, events };
}

const ctx = { taskId: 'task-1', userId: 'user-1', orchestrationEpoch: 5 } as never;
const row = { id: 'ts-1', round: 0 } as never;

describe('a result handed off after a Retry moved the task on', () => {
  const cleanup = vi.fn(async () => 0);
  afterEach(() => {
    cleanup.mockClear();
    setContainerCleanupRunner(null);
  });

  it('hands nothing off once the task is at a newer epoch', async () => {
    const { db, statements } = taskDb(6);
    await handleResult(db, ctx, STEP_ID, { status: 'done', row, output: null } as never);
    await handleResult(db, ctx, STEP_ID, { status: 'failed', row, error: 'boom' } as never);
    expect(statements).toEqual([]);
  });

  it('fails nothing when the task moved on between the check and the write', async () => {
    setContainerCleanupRunner(cleanup);
    const { db, statements } = taskDb(5, 6);
    await handleResult(db, ctx, STEP_ID, { status: 'failed', row, error: 'boom' } as never);
    expect(statements).toEqual(['update tasks']);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('fails the task, and releases what it holds, while it is still at its epoch', async () => {
    setContainerCleanupRunner(cleanup);
    const { db, statements } = taskDb(5, 5, { selectRows: [] });
    await handleResult(db, ctx, STEP_ID, { status: 'failed', row, error: 'boom' } as never);
    expect(statements[0]).toBe('update tasks');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('stamps a parked form and marks the task waiting while the pass owns the row', async () => {
    const { db, statements } = taskDb(5, 5, { rowStatus: 'waiting_form', selectRows: [] });
    await handleResult(db, ctx, STEP_ID, { status: 'waiting_form', row, formSchema: {} } as never);
    expect(statements[0]).toBe('update task_steps');
    expect(statements).toContain('update tasks');
    expect(statements.at(-1)).toBe('insert task_events');
  });

  it('marks nothing waiting once a Retry reset the parked row after the check', async () => {
    const { db, statements } = taskDb(5, 5, { rowStatus: 'pending' });
    await handleResult(db, ctx, STEP_ID, { status: 'waiting_form', row, formSchema: {} } as never);
    expect(statements).toEqual(['update task_steps']);
  });

  it('raises no fix-loop gate on a row a Retry reset after the check', async () => {
    // Past the fix-round cap, so the loop escalates to its gate on the source row.
    const { db, statements, events } = taskDb(5, 5, {
      rowStatus: 'pending',
      selectRows: [{ n: 99 }],
    });
    const loopBack = { status: 'loop_back', row, diagnosis: 'a defect', sourceStepId: STEP_ID };
    await handleResult(db, ctx, STEP_ID, loopBack as never);
    expect(statements.at(-1)).toBe('update task_steps');
    expect(statements).not.toContain('update tasks');
    // No request for a round the gate was never raised for.
    expect(events).toEqual(['step.loop_back']);
  });

  it('completes nothing, and reaps nothing, once the task moved to a newer epoch', async () => {
    setContainerCleanupRunner(cleanup);
    const { db, statements } = taskDb(6);
    await markTaskCompleted(db, 'task-1', { epoch: 5 });
    expect(statements).toEqual(['update tasks']);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
