import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { autoResumeFailedStep } from '../src/queues/_step-reset.js';
import { PROVIDER_FATAL_HEADLINES } from '../src/queues/cli-exec/failure-class.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const ROW = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000d1';
const AGENT = '00000000-0000-4000-8000-0000000000e1';

/** A task failed on its fan-out step's rate limit: a failed trailing run and an agent it killed. */
function setup(taskStatus: 'failed' | 'running') {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskEvents: schema.taskEvents,
  });
  const outage = `${PROVIDER_FATAL_HEADLINES.rate_limit}: 429`;
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status: taskStatus,
    allowanceAutoResumeCount: 0,
  });
  fake.insert(schema.taskSteps, {
    id: ROW,
    taskId: TASK,
    stepId: 'fan-out',
    round: 0,
    status: 'failed',
    errorMessage: outage,
  });
  fake.insert(schema.cliInvocations, {
    id: RUN,
    taskId: TASK,
    taskStepId: ROW,
    mode: 'cli',
    exitCode: 1,
    errorMessage: outage,
    endedAt: fake.now(),
    createdAt: fake.now(),
  });
  fake.insert(schema.taskStepAgentMinings, {
    id: AGENT,
    taskStepId: ROW,
    status: 'failed',
    errorMessage: outage,
  });
  const updated: string[] = [];
  fake.hooks.beforeUpdate = (table) => {
    updated.push(getTableName(table));
  };
  const resume = () =>
    autoResumeFailedStep(fake.db as unknown as Database, {
      taskId: TASK,
      stepId: 'fan-out',
      round: 0,
      providerId: null,
      via: 'test',
    });
  const one = (rows: Record<string, unknown>[], id: string) => rows.find((r) => r.id === id)!;
  return { fake, updated, resume, one };
}

describe('the allowance auto-resume', () => {
  it('takes runs and agent rows, then the step, then the task, as a Retry does', async () => {
    const t = setup('failed');
    expect(await t.resume()).toBe(true);
    expect(t.updated).toEqual([
      'cli_invocations',
      'task_step_agent_minings',
      'task_steps',
      'tasks',
    ]);
    expect(t.one(t.fake.rows(schema.tasks), TASK)).toMatchObject({
      status: 'running',
      allowanceAutoResumeCount: 1,
    });
    expect(t.one(t.fake.rows(schema.taskSteps), ROW)).toMatchObject({ status: 'running' });
  });

  it('changes nothing when the task is no longer failed', async () => {
    const t = setup('running');
    expect(await t.resume()).toBe(false);
    expect(t.one(t.fake.rows(schema.taskSteps), ROW)).toMatchObject({ status: 'failed' });
    expect(t.one(t.fake.rows(schema.cliInvocations), RUN)).toMatchObject({ supersededAt: null });
    expect(t.one(t.fake.rows(schema.taskStepAgentMinings), AGENT)).toMatchObject({
      userRetryRequestedAt: null,
    });
    expect(t.fake.rows(schema.taskEvents)).toEqual([]);
  });
});
