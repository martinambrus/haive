import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { resetRowsForRerun } from '../src/routes/tasks/steps.js';

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
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { eq, inArray } = await import('drizzle-orm');
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
    await resetRowsForRerun(handle as never, TASK, [target as never], new Date());
    const dialect = new PgDialect();
    const query = (where: unknown) => dialect.sqlToQuery(where as never);
    expect(query(queries.find((q) => q.fields != null)!.where)).toEqual(
      query(eq(schema.taskSteps.taskId, TASK)),
    );
    expect(query(queries.at(-1)!.where)).toEqual(
      query(inArray(schema.taskSteps.id, [target.id as string])),
    );
    expect(sets[0]).not.toHaveProperty('guardState');
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
  const result = await resetRowsForRerun(fake.db as never, TASK, [target as never], new Date());
  expect(result).toEqual([expect.objectContaining({ id: extra.id, status: 'running' })]);
  expect(fake.rows(schema.taskSteps).find((r) => r.id === extra.id)).toMatchObject({
    status: 'pending',
    guardState: null,
  });
});
