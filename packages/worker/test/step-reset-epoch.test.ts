import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';

vi.mock('@haive/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/database')>()),
  resetDagCurrentLevelForRetry: vi.fn(async () => undefined),
}));

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

/** One failed target row with nothing downstream, on a task at `taskEpoch`. The epoch write
 *  lands only when it names no epoch or the one the task is at. */
function resetDb(taskEpoch: number) {
  const target = {
    id: 'ts-1',
    status: 'failed',
    runSeq: 3,
    stepIndex: 3,
    carriedWorkMs: 0,
    carriedIdleMs: 0,
    carriedUserActiveMs: 0,
    startedAt: null,
    endedAt: null,
    idleMs: 0,
    userActiveMs: 0,
    waitingStartedAt: null,
  };
  const epochWrites: unknown[][] = [];
  const thenable = (value: unknown) => ({
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(value).then(res, rej),
  });
  const handle = {
    select: () => ({
      from: () => ({
        where: () => ({
          ...thenable([]),
          limit: async () => [target],
          // The id-ordered lock of the rows the reset writes.
          orderBy: () => ({ for: async () => [{ id: target.id }] }),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: (cond: unknown) => ({
          ...thenable(undefined),
          returning: async () => {
            if (tableNameOf(table) !== 'tasks') return [];
            const epochs = conditionValues(cond).filter((v) => typeof v === 'number');
            epochWrites.push(epochs);
            return epochs.length === 0 || epochs.includes(taskEpoch)
              ? [{ epoch: taskEpoch + 1 }]
              : [];
          },
        }),
      }),
    }),
    delete: () => ({ where: () => thenable(undefined) }),
  };
  const db = {
    ...handle,
    transaction: async (fn: (tx: unknown) => unknown) => fn(handle),
  } as unknown as Database;
  return { db, epochWrites };
}

describe('resetStepAndDownstream at an expected epoch', () => {
  it('resets and bumps the task while it is still at that epoch', async () => {
    const { db, epochWrites } = resetDb(5);
    await expect(resetStepAndDownstream(db, 'task-1', '04-spec', 0, 5)).resolves.toEqual({
      downstreamReset: 0,
      newEpoch: 6,
    });
    expect(epochWrites).toEqual([[5]]);
  });

  it('answers superseded once a Retry moved the task on', async () => {
    const { db, epochWrites } = resetDb(6);
    await expect(resetStepAndDownstream(db, 'task-1', '04-spec', 0, 5)).resolves.toBe('superseded');
    expect(epochWrites).toEqual([[5]]);
  });

  it('resets whatever the epoch when the caller names none', async () => {
    const { db, epochWrites } = resetDb(6);
    await expect(resetStepAndDownstream(db, 'task-1', '04-spec', 0)).resolves.toEqual({
      downstreamReset: 0,
      newEpoch: 7,
    });
    expect(epochWrites).toEqual([[]]);
  });
});

it.each([null, { version: 1, guardedSpans: [] }])(
  'F2 ordinary reset keeps main lock/read predicates and SET columns: %j',
  async (executionContract) => {
    const { createFakeDb } = await import('@haive/database/testing');
    const { schema } = await import('@haive/database');
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { and, eq, inArray } = await import('drizzle-orm');
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      cliInvocations: schema.cliInvocations,
      taskStepAgentMinings: schema.taskStepAgentMinings,
    });
    const task = fake.insert(schema.tasks, { executionContract, orchestrationEpoch: 3 });
    const target = fake.insert(schema.taskSteps, {
      taskId: task.id,
      stepId: 'target',
      status: 'failed',
      round: 0,
      runSeq: 2,
      stepIndex: 2,
    });
    const held = fake.insert(schema.taskSteps, {
      taskId: task.id,
      stepId: 'handoff',
      status: 'done',
      round: 0,
      runSeq: 1,
      stepIndex: 1,
    });
    fake.insert(schema.taskSteps, {
      taskId: task.id,
      stepId: 'other-round',
      status: 'running',
      round: 1,
      runSeq: 3,
      stepIndex: 3,
    });
    const queries: { fields: unknown; where: unknown }[] = [];
    const sets: object[] = [];
    const handle = {
      ...fake.db,
      select: (fields?: never) => ({
        from: (table: never) => ({
          where: (where: never) => {
            if (table === schema.taskSteps) queries.push({ fields, where });
            return fake.db.select(fields).from(table).where(where);
          },
        }),
      }),
      update: (table: never) => ({
        set: (values: never) => {
          if (table === schema.taskSteps) sets.push(values);
          return fake.db.update(table).set(values);
        },
      }),
    };
    const db = {
      ...handle,
      transaction: async (fn: (tx: unknown) => unknown) => fn(handle),
    } as unknown as Database;
    await resetStepAndDownstream(db, task.id as string, 'target', 0, 3, false, [held.id as string]);
    const dialect = new PgDialect();
    const query = (where: unknown) => dialect.sqlToQuery(where as never);
    const lock = queries.find((q) => q.fields != null)!;
    expect(query(lock.where)).toEqual(
      query(inArray(schema.taskSteps.id, [target.id as string, held.id as string])),
    );
    expect(query(queries.at(-1)!.where)).toEqual(
      query(
        and(
          eq(schema.taskSteps.taskId, task.id as string),
          inArray(schema.taskSteps.id, [target.id as string]),
        ),
      ),
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]).not.toHaveProperty('guardState');
  },
);
