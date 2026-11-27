import { getTableName, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));

import { LATE_LOCK_WAIT_MS, schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { refusingWhenLocked, resetRowsForRerun } from '../src/routes/tasks/steps.js';

const TASK = '00000000-0000-4000-8000-000000000001';

describe('resetting rows for a re-run', () => {
  it('ends what a pass recorded for a row after the first sweep and before the row was taken', async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      cliInvocations: schema.cliInvocations,
      taskStepAgentMinings: schema.taskStepAgentMinings,
      taskDagPlans: schema.taskDagPlans,
    });
    fake.insert(schema.tasks, { id: TASK, status: 'running' });
    const step = fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: '08c-peer-review',
      rerunGeneration: 2,
      applyReceipt: { id: 'approved-run', kind: 'custom-migration', input: 'command' },
      round: 0,
      status: 'running',
    });
    // The pass held the row and recorded a run and an agent before the reset could take it; the
    // reset's own write to the row waited for that.
    let recorded = false;
    fake.hooks.beforeUpdate = (table) => {
      if (table !== schema.taskSteps || recorded) return;
      recorded = true;
      fake.insert(schema.cliInvocations, {
        taskId: TASK,
        taskStepId: step.id,
        mode: 'agent_mining',
        prompt: 'review',
      });
      fake.insert(schema.taskStepAgentMinings, {
        taskStepId: step.id,
        agentId: 'peer-reviewer',
        agentTitle: 'peer-reviewer',
        status: 'pending',
      });
    };

    await fake.db.transaction((tx) =>
      resetRowsForRerun(tx as never, TASK, [step as never], new Date()),
    );

    expect(recorded).toBe(true);
    expect(fake.rows(schema.cliInvocations).map((r) => r.supersededAt)).toEqual([expect.any(Date)]);
    expect(fake.rows(schema.taskStepAgentMinings)).toEqual([]);
    expect(fake.rows(schema.taskSteps)[0]).toMatchObject({
      status: 'pending',
      applyReceipt: null,
      rerunGeneration: 3,
    });
  });
});

it.each([null, { version: 1, guardedSpans: [] }])(
  'F2 ordinary API reset reads only caller ids and keeps main SET columns: %j',
  async (executionContract) => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      cliInvocations: schema.cliInvocations,
      taskStepAgentMinings: schema.taskStepAgentMinings,
      taskDagPlans: schema.taskDagPlans,
    });
    fake.insert(schema.tasks, { id: TASK, executionContract });
    const target = fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: 'target',
      status: 'failed',
      round: 0,
      runSeq: 2,
      stepIndex: 2,
    });
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: 'unrelated',
      status: 'running',
      round: 1,
      runSeq: 3,
      stepIndex: 3,
    });
    const { handle, statements } = captureStatements(fake.db);
    await resetRowsForRerun(handle as never, TASK, [target as never], new Date(), {
      executionContract,
    });
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
      runSweep,
      miningSweep,
      {
        kind: 'findFirst',
        table: 'taskDagPlans',
        columns: { id: true },
        where: { sql: '"task_dag_plans"."task_id" = $1', params: [TASK] },
      },
      {
        kind: 'select',
        table: 'task_steps',
        fields: ['id', 'taskId'],
        where: { sql: '"task_steps"."task_id" = $1', params: [TASK] },
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
    ]);
  },
);

it('F4 returns extra held rows with their pre-reset liveness', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    executionContract: {
      version: 1,
      guardedSpans: [
        {
          id: 'work',
          firstStepId: 'entry',
          lastStepId: 'entry',
          predicateId: 'module.fx.guard',
          args: {},
        },
      ],
    },
  });
  const target = fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: 'producer',
    status: 'failed',
    round: 0,
    runSeq: 1,
    stepIndex: 1,
  });
  const extra = fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: 'entry',
    status: 'running',
    round: 0,
    runSeq: 2,
    stepIndex: 2,
    guardState: { run: true },
  });
  const result = await fake.db.transaction((tx) =>
    resetRowsForRerun(tx as never, TASK, [target as never], new Date()),
  );
  expect(result).toEqual([expect.objectContaining({ id: extra.id, status: 'running' })]);
  expect(fake.rows(schema.taskSteps).find((r) => r.id === extra.id)).toMatchObject({
    status: 'pending',
    guardState: null,
  });
});

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

describe('late reset lock wait', () => {
  it('pins the production wait below the default Postgres deadlock detector', () => {
    expect(LATE_LOCK_WAIT_MS).toBe(250);
    // Leave 750 ms for a peer that began waiting before the reverse-tier sweep.
    // Growing this bound shrinks that margin against the default 1 s detector.
    expect(LATE_LOCK_WAIT_MS).toBeLessThan(1000);
  });

  it.each([undefined, 7])('sets and restores the injectable wait (%s)', async (waitMs) => {
    const log: string[] = [];
    const tx = {
      execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
        log.push(new PgDialect().sqlToQuery(query).sql);
      },
    };
    const result = await refusingWhenLocked(
      tx as never,
      async () => {
        log.push('held sweep');
        return 'reset';
      },
      waitMs,
    );
    expect(result).toBe('reset');
    expect(log).toEqual([
      `SET LOCAL lock_timeout = '${waitMs ?? 250}ms'`,
      'held sweep',
      'SET LOCAL lock_timeout = DEFAULT',
    ]);
  });

  it('maps a wrapped 55P03 by code, preserving unrelated errors by identity', async () => {
    const tx = { execute: async () => undefined };
    const timeout = Object.assign(new Error('opaque'), {
      cause: Object.assign(new Error('opaque'), { code: '55P03' }),
    });
    await expect(
      refusingWhenLocked(
        tx as never,
        async () => {
          throw timeout;
        },
        7,
      ),
    ).rejects.toMatchObject({ status: 503 });
    const unrelated = new Error('55P03');
    await expect(
      refusingWhenLocked(
        tx as never,
        async () => {
          throw unrelated;
        },
        7,
      ),
    ).rejects.toBe(unrelated);
  });
});
