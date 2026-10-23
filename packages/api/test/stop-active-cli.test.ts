import { beforeEach, describe, expect, it, vi } from 'vitest';

const kill = vi.hoisted(() => vi.fn(async (_taskId: string) => 0));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: kill }));
vi.mock('../src/db.js', () => ({ getDb: () => undefined }));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { FIX_LOOP_ACTION_FIELD } from '@haive/shared';
import { stopActiveCliInvocations } from '../src/lib/task-control.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const EARLIER = new Date('2026-10-15T09:00:00.000Z');

function setup(task: Record<string, unknown> = {}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    cliInvocations: schema.cliInvocations,
  });
  fake.insert(schema.tasks, { id: TASK, status: 'running', ...task });
  const step = fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '07-phase-2-implement',
    round: 0,
    status: 'waiting_cli',
  });
  fake.insert(schema.cliInvocations, {
    taskId: TASK,
    taskStepId: step.id,
    mode: 'cli',
    prompt: 'implement',
  });
  return { fake, step };
}

describe('stopping a task', () => {
  beforeEach(() => kill.mockClear());

  it('leaves every run live and kills nothing when failing the step throws', async () => {
    const { fake } = setup();
    fake.hooks.beforeUpdate = (table) => {
      if (table === schema.taskSteps) throw new Error('the step write failed');
    };
    await expect(
      stopActiveCliInvocations(fake.db as never, TASK, { failTask: true }),
    ).rejects.toThrow('the step write failed');
    expect(fake.rows(schema.cliInvocations).map((r) => r.supersededAt)).toEqual([null]);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('ends a run a pass recorded while the Stop was failing its step', async () => {
    const { fake, step } = setup();
    // The pass held the row and recorded a run; the Stop's write to the row waited for it.
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
    };
    const result = await stopActiveCliInvocations(fake.db as never, TASK, { failTask: true });
    expect(recorded).toBe(true);
    expect(fake.rows(schema.cliInvocations).map((r) => r.supersededAt)).toEqual([
      expect.any(Date),
      expect.any(Date),
    ]);
    expect(result).toMatchObject({ cancelled: 2, stopped: 1 });
    expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ status: 'failed' });
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'failed' });
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('names the instant it failed the task, the very stamp the task carries', async () => {
    const { fake } = setup();
    const result = await stopActiveCliInvocations(fake.db as never, TASK, { failTask: true });
    const { completedAt } = fake.rows(schema.tasks)[0]!;
    expect(completedAt).toBeInstanceOf(Date);
    expect(result.failedAt).toBe((completedAt as Date).toISOString());
  });

  it.each([
    ['fails a pending row that holds a fix-loop gate answer', { [FIX_LOOP_ACTION_FIELD]: 'x' }, 1],
    ['leaves a pending row that holds another form answer', { note: 'keep me' }, 0],
    ['leaves a pending row whose gate field is not a string', { [FIX_LOOP_ACTION_FIELD]: 3 }, 0],
    ['leaves a pending row that holds no answer', null, 0],
  ])('%s', async (_name, formValues, stopped) => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      cliInvocations: schema.cliInvocations,
    });
    fake.insert(schema.tasks, { id: TASK, status: 'running' });
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: '08b-test-management',
      round: 1,
      status: 'pending',
      formValues,
    });
    const result = await stopActiveCliInvocations(fake.db as never, TASK, { failTask: true });
    expect(result).toMatchObject({ cancelled: 0, stopped });
    expect(fake.rows(schema.taskSteps)[0]).toMatchObject({
      status: stopped ? 'failed' : 'pending',
    });
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: stopped ? 'failed' : 'running' });
  });

  it.each([
    [
      'a task that had already failed',
      { failTask: true },
      { status: 'failed', completedAt: EARLIER },
    ],
    [
      'a stop that does not fail the task',
      { failTask: false },
      { status: 'running', completedAt: null },
    ],
  ])('names no instant for %s', async (_name, opts, task) => {
    const { fake } = setup(task);
    const result = await stopActiveCliInvocations(fake.db as never, TASK, opts);
    expect(result).toMatchObject({ cancelled: 1, stopped: 1, failedAt: null });
    expect(fake.rows(schema.tasks)[0]).toMatchObject(task);
  });
});
