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
    expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ status: 'pending' });
  });
});
