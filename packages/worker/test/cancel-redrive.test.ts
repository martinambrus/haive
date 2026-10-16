import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@haive/database';

const queue = vi.hoisted(() => ({
  jobs: [] as { name: string; data: unknown; state: string }[],
  asked: [] as string[][],
}));

vi.mock('../src/queues/task-queue.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTaskQueue: () => ({
    getJobs: async (states: string[]) => {
      queue.asked.push(states);
      return queue.jobs.filter((j) => states.includes(j.state));
    },
  }),
}));

import {
  CANCEL_REDRIVE_BATCH,
  CANCEL_REDRIVE_LOOKBACK_MS,
  redriveCancelledTasks,
  readQueuedCancelTaskIds,
  type CancelRedriveDeps,
} from '../src/queues/stalled-redrive.js';

function rendered(cond: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(cond as SQL);
}

/** The candidates SELECT is faked; its subqueries are built by a real drizzle builder, so the
 *  rendered condition can be read back. */
function makeDb(
  rows: { taskId: string; userId: string }[],
  opts: { insertFails?: boolean } = {},
): {
  db: Database;
  seen: { where?: unknown; limit?: number; inserted: unknown[]; deleted: number };
} {
  const seen: { where?: unknown; limit?: number; inserted: unknown[]; deleted: number } = {
    inserted: [],
    deleted: 0,
  };
  const real = drizzle.mock();
  const outer = {
    from: () => ({
      where: (cond: unknown) => {
        seen.where = cond;
        return {
          orderBy: () => ({
            limit: (n: number) => {
              seen.limit = n;
              return Promise.resolve(rows);
            },
          }),
        };
      },
    }),
  };
  const db = {
    select: (fields: Parameters<typeof real.select>[0] & object) =>
      'taskId' in fields ? outer : real.select(fields),
    insert: () => ({
      values: (v: unknown) => ({
        returning: async () => {
          if (opts.insertFails) throw new Error('db blinked');
          seen.inserted.push(v);
          return [{ id: `event-${seen.inserted.length}` }];
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        seen.deleted += 1;
      },
    }),
  };
  return { db: db as unknown as Database, seen };
}

function deps(
  enqueued: string[],
  queuedIds: Set<string> | null = new Set(),
  enqueueCancel?: CancelRedriveDeps['enqueueCancel'],
): CancelRedriveDeps {
  return {
    enqueueCancel:
      enqueueCancel ??
      (async (taskId) => {
        enqueued.push(taskId);
      }),
    queuedCancelTaskIds: async () => queuedIds,
  };
}

describe('redriveCancelledTasks', () => {
  it('counts the attempt before the CANCEL exists, so a count it cannot record queues nothing', async () => {
    const { db } = makeDb([{ taskId: 'task-1', userId: 'u1' }], { insertFails: true });
    const enqueued: string[] = [];
    expect(await redriveCancelledTasks(db, deps(enqueued), { staleMs: 300_000 })).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it('records the re-drive with its attempt number', async () => {
    const { db, seen } = makeDb([{ taskId: 'task-1', userId: 'u1' }]);
    const enqueued: string[] = [];
    await redriveCancelledTasks(db, deps(enqueued), { staleMs: 300_000 });
    expect(enqueued).toEqual(['task-1']);
    expect(seen.inserted).toEqual([
      { taskId: 'task-1', eventType: 'task.cancel_redriven', payload: { attempt: 1 } },
    ]);
  });

  it('queues one CANCEL for a cancelled task whose teardown never finished', async () => {
    const { db } = makeDb([{ taskId: 'task-1', userId: 'user-1' }]);
    const enqueued: string[] = [];
    const n = await redriveCancelledTasks(db, deps(enqueued), { staleMs: 300_000 });
    expect(n).toBe(1);
    expect(enqueued).toEqual(['task-1']);
  });

  it('selects on a cancelled task with no recent cancelled event and no cancel_finished', async () => {
    const { db, seen } = makeDb([]);
    await redriveCancelledTasks(db, deps([]), { staleMs: 300_000 });
    const { sql, params } = rendered(seen.where);
    expect(sql).toContain('"tasks"."status" = $');
    expect(sql).toContain('not exists');
    expect(params).toEqual(
      expect.arrayContaining(['cancelled', 'task.cancelled', 'task.cancel_finished']),
    );
    expect(seen.limit).toBe(CANCEL_REDRIVE_BATCH);
  });

  it('bounds the event age on both sides: older than the cutoff, newer than the lookback', async () => {
    const before = Date.now();
    const { db, seen } = makeDb([]);
    await redriveCancelledTasks(db, deps([]), { staleMs: 300_000 });
    const { sql, params } = rendered(seen.where);
    const ages = params
      .filter((v): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v))
      .map((v) => before - new Date(v).getTime())
      .sort((x, y) => x - y);
    expect(ages).toHaveLength(2);
    expect(ages[0]).toBeGreaterThanOrEqual(300_000 - 1000);
    expect(ages[0]).toBeLessThan(300_000 + 5000);
    expect(ages[1]).toBeGreaterThanOrEqual(CANCEL_REDRIVE_LOOKBACK_MS - 1000);
    expect(sql).toMatch(/created_at" > \$\d+/);
    expect(sql).toMatch(/created_at" >= \$\d+/);
  });

  it('skips a task that already has a CANCEL queued', async () => {
    const { db } = makeDb([
      { taskId: 'task-1', userId: 'user-1' },
      { taskId: 'task-2', userId: 'user-2' },
    ]);
    const enqueued: string[] = [];
    const n = await redriveCancelledTasks(db, deps(enqueued, new Set(['task-1'])), {
      staleMs: 300_000,
    });
    expect(n).toBe(1);
    expect(enqueued).toEqual(['task-2']);
  });

  it('queues nothing when the task queue cannot be read', async () => {
    const { db } = makeDb([{ taskId: 'task-1', userId: 'user-1' }]);
    const enqueued: string[] = [];
    const n = await redriveCancelledTasks(db, deps(enqueued, null), { staleMs: 300_000 });
    expect(n).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it('carries on past a task whose enqueue keeps failing', async () => {
    const { db, seen } = makeDb([
      { taskId: 'task-1', userId: 'user-1' },
      { taskId: 'task-2', userId: 'user-2' },
    ]);
    const enqueued: string[] = [];
    const n = await redriveCancelledTasks(
      db,
      deps(enqueued, new Set(), async (taskId) => {
        if (taskId === 'task-1') throw new Error('redis blinked');
        enqueued.push(taskId);
      }),
      { staleMs: 300_000 },
    );
    expect(n).toBe(1);
    expect(enqueued).toEqual(['task-2']);
    expect(seen.deleted).toBe(1);
  });
});

describe('readQueuedCancelTaskIds', () => {
  it('counts a CANCEL waiting, active or delayed, and not one completed or failed in history', async () => {
    queue.jobs = [
      { name: 'cancel-task', data: { taskId: 'waiting' }, state: 'waiting' },
      { name: 'cancel-task', data: { taskId: 'active' }, state: 'active' },
      { name: 'cancel-task', data: { taskId: 'delayed' }, state: 'delayed' },
      { name: 'cancel-task', data: { taskId: 'done-in-history' }, state: 'completed' },
      { name: 'cancel-task', data: { taskId: 'failed-in-history' }, state: 'failed' },
      { name: 'advance-step', data: { taskId: 'advancing' }, state: 'waiting' },
    ];
    const ids = await readQueuedCancelTaskIds();
    expect([...ids!].sort()).toEqual(['active', 'delayed', 'waiting']);
  });
});
