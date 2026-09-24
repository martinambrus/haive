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
 *  that names no epoch lands whatever the task's is. */
function taskDb(readEpoch: number, writeEpoch = readEpoch) {
  const statements: string[] = [];
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
              const epochs = conditionValues(cond).filter((v) => typeof v === 'number');
              return epochs.length > 0 && !epochs.includes(writeEpoch) ? [] : [{ id: 'task-1' }];
            },
          }),
        }),
      };
    },
    insert: (table: unknown) => {
      statements.push(`insert ${tableNameOf(table)}`);
      return { values: async () => undefined };
    },
    select: () => {
      statements.push('select');
      throw new Error('this test reads nothing but the epoch');
    },
  } as unknown as Database;
  return { db, statements };
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

  it('completes nothing, and reaps nothing, once the task moved to a newer epoch', async () => {
    setContainerCleanupRunner(cleanup);
    const { db, statements } = taskDb(6);
    await markTaskCompleted(db, 'task-1', 5);
    expect(statements).toEqual(['update tasks']);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
