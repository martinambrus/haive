import { createFakeDb } from '@haive/database/testing';
import { getTableName, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
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
    const { schema } = await import('@haive/database');
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      cliInvocations: schema.cliInvocations,
      taskStepAgentMinings: schema.taskStepAgentMinings,
      taskDagPlans: schema.taskDagPlans,
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
    const { handle, statements } = captureStatements(fake.db);
    // Exercise the real DAG helper too: its relational lookup is part of main's list.
    const actual = await vi.importActual<typeof import('@haive/database')>('@haive/database');
    const { resetDagCurrentLevelForRetry } = await import('@haive/database');
    vi.mocked(resetDagCurrentLevelForRetry).mockImplementationOnce(
      actual.resetDagCurrentLevelForRetry,
    );
    const db = {
      ...handle,
      transaction: async (fn: (tx: unknown) => unknown) => fn(handle),
    } as unknown as Database;
    await resetStepAndDownstream(
      db,
      task.id as string,
      'target',
      0,
      3,
      false,
      [held.id as string],
      executionContract,
    );
    const stepWrite = {
      kind: 'update',
      table: 'task_steps',
      keys: [
        'applyReceipt',
        'carriedIdleMs',
        'carriedUserActiveMs',
        'carriedWorkMs',
        'degradedNote',
        'detectOutput',
        'endedAt',
        'errorHint',
        'errorMessage',
        'formSchema',
        'formValues',
        'idleMs',
        'integrationWait',
        'iterationCount',
        'iterations',
        'mergeResolveState',
        'output',
        'rerunGeneration',
        'startedAt',
        'status',
        'statusMessage',
        'summary',
        'updatedAt',
        'userActiveMs',
        'waitingStartedAt',
        'warningMessage',
      ],
      where: { sql: '"task_steps"."id" = $1', params: [target.id] },
    };
    const runSweep = {
      kind: 'update',
      table: 'cli_invocations',
      keys: ['supersededAt'],
      where: {
        sql: '(("cli_invocations"."task_step_id" in ($1) or "cli_invocations"."summary_for_step_id" in ($2)) and "cli_invocations"."superseded_at" is null)',
        params: [target.id, target.id],
      },
    };
    const miningSweep = {
      kind: 'delete',
      table: 'task_step_agent_minings',
      where: { sql: '"task_step_agent_minings"."task_step_id" in ($1)', params: [target.id] },
    };
    // Literal statement list from 4e0cc0da4; do not derive it from current reset code.
    expect(statements).toEqual([
      {
        kind: 'select',
        table: 'task_steps',
        fields: '*',
        where: {
          sql: '("task_steps"."task_id" = $1 and "task_steps"."step_id" = $2 and "task_steps"."round" = $3)',
          params: [task.id, 'target', 0],
        },
        limit: 1,
      },
      {
        kind: 'select',
        table: 'task_steps',
        fields: '*',
        where: {
          sql: '("task_steps"."task_id" = $1 and "task_steps"."round" = $2 and "task_steps"."run_seq" > $3)',
          params: [task.id, 0, 2],
        },
      },
      runSweep,
      miningSweep,
      {
        kind: 'findFirst',
        table: 'taskDagPlans',
        columns: { id: true },
        where: { sql: '"task_dag_plans"."task_id" = $1', params: [task.id] },
      },
      {
        kind: 'select',
        table: 'task_steps',
        fields: ['id', 'taskId'],
        where: { sql: '"task_steps"."id" in ($1, $2)', params: [target.id, held.id] },
        order: [{ sql: '"task_steps"."id"', params: [] }],
        lock: ['no key update'],
      },
      {
        kind: 'select',
        table: 'task_steps',
        fields: '*',
        where: { sql: '"task_steps"."id" in ($1)', params: [target.id] },
      },
      stepWrite,
      runSweep,
      miningSweep,
      {
        kind: 'update',
        table: 'tasks',
        keys: ['orchestrationEpoch', 'updatedAt'],
        where: {
          sql: '("tasks"."id" = $1 and "tasks"."orchestration_epoch" = $2 and "tasks"."dead_at" is null)',
          params: [task.id, 3],
        },
      },
    ]);
  },
);

/** Capture every statement, including relational reads and non-step tables. */
function captureStatements(db: ReturnType<typeof createFakeDb>['db']) {
  const statements: Record<string, unknown>[] = [];
  const dialect = new PgDialect();
  const condition = (where: unknown) => {
    const { sql, params } = dialect.sqlToQuery(where as never);
    return { sql, params };
  };
  const handle = {
    ...db,
    query: new Proxy(db.query, {
      get: (tables, name: string) =>
        new Proxy(tables[name]!, {
          get: (table, method: string) => (opts: Record<string, unknown>) => {
            statements.push({ kind: method, table: name, ...opts, where: condition(opts.where) });
            return table[method as 'findFirst'](opts);
          },
        }),
    }),
    select: (fields?: Record<string, unknown>) => ({
      from: (table: Parameters<ReturnType<typeof db.select>['from']>[0]) => {
        const statement: Record<string, unknown> = {
          kind: 'select',
          table: getTableName(table),
          fields: fields ? Object.keys(fields) : '*',
        };
        statements.push(statement);
        const builder = db.select(fields).from(table);
        const captured = new Proxy(builder, {
          get:
            (query, method: keyof typeof builder) =>
            (...args: unknown[]) => {
              if (method === 'where') statement.where = condition(args[0]);
              if (method === 'limit') statement.limit = args[0];
              if (method === 'orderBy')
                statement.order = args.map((arg) => condition(sql`${arg as never}`));
              if (method === 'for') statement.lock = args;
              const result = (query[method] as (...values: unknown[]) => unknown)(...args);
              return result === builder ? captured : result;
            },
        });
        return captured;
      },
    }),
    update: (table: Parameters<typeof db.update>[0]) => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          statements.push({
            kind: 'update',
            table: getTableName(table),
            keys: Object.keys(values).sort(),
            where: condition(where),
          });
          return db.update(table).set(values).where(where);
        },
      }),
    }),
    delete: (table: Parameters<typeof db.delete>[0]) => ({
      where: (where: unknown) => {
        statements.push({ kind: 'delete', table: getTableName(table), where: condition(where) });
        return db.delete(table).where(where);
      },
    }),
    execute: (query: unknown) => {
      statements.push({ kind: 'execute', query: condition(query) });
      return db.execute(query);
    },
    insert: (table: Parameters<typeof db.insert>[0]) => {
      statements.push({ kind: 'insert', table: getTableName(table) });
      return db.insert(table);
    },
  };
  return { handle, statements };
}
