import { beforeEach, describe, expect, it, vi } from 'vitest';

const kill = vi.hoisted(() => vi.fn(async (_taskId: string) => 0));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: kill }));
vi.mock('../src/db.js', () => ({ getDb: () => undefined }));

import { eq } from 'drizzle-orm';
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
    ['leaves a pending row that holds no answer when the task points at no row', null, 0],
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

  describe('a pending row with no park marker', () => {
    const POINTER = { currentStepId: '08b-test-management', currentRound: 1 };
    const seed = (
      task: Record<string, unknown>,
      row: Record<string, unknown> = {},
      opts: { failTask: boolean } = { failTask: true },
    ) => {
      const fake = createFakeDb({
        tasks: schema.tasks,
        taskSteps: schema.taskSteps,
        cliInvocations: schema.cliInvocations,
      });
      fake.insert(schema.tasks, { id: TASK, status: 'running', ...POINTER, ...task });
      fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: '08b-test-management',
        round: 1,
        status: 'pending',
        formValues: null,
        ...row,
      });
      return { fake, stop: () => stopActiveCliInvocations(fake.db as never, TASK, opts) };
    };

    it('is failed when it is the current row of a running task', async () => {
      const { fake, stop } = seed({});
      const result = await stop();
      expect(result).toMatchObject({ cancelled: 0, stopped: 1 });
      const row = fake.rows(schema.taskSteps)[0]!;
      expect(row).toMatchObject({ status: 'failed', errorMessage: 'Stopped by user' });
      expect(row.endedAt).toBeInstanceOf(Date);
      expect(row.startedAt ?? null).toBeNull();
      expect(fake.rows(schema.tasks)[0]).toMatchObject({
        status: 'failed',
        errorMessage: 'Stopped by user',
      });
    });

    it.each([
      ['is not the current row', {}, { stepId: '09-other' }],
      ['belongs to an earlier round', { currentRound: 2 }, {}],
      ['belongs to a task that is waiting_user', { status: 'waiting_user' }, {}],
      ['belongs to a task that is queued', { status: 'queued' }, {}],
      ['belongs to a task that already failed', { status: 'failed' }, {}],
      ['belongs to a dead task', { deadAt: EARLIER }, {}],
      ['is current but done', {}, { status: 'done' }],
      ['is current but skipped', {}, { status: 'skipped' }],
      ['is current but failed', {}, { status: 'failed' }],
      ['is current but waiting for a form', {}, { status: 'waiting_form' }],
    ])('is left alone when it %s', async (_name, task, row) => {
      const { fake, stop } = seed(task, row);
      const taskBefore = { ...fake.rows(schema.tasks)[0] };
      const rowBefore = { ...fake.rows(schema.taskSteps)[0] };
      const result = await stop();
      expect(result).toMatchObject({ cancelled: 0, stopped: 0 });
      expect(fake.rows(schema.taskSteps)[0]).toEqual(rowBefore);
      expect(fake.rows(schema.tasks)[0]).toEqual(taskBefore);
    });

    it('is left alone when the stop does not fail the task', async () => {
      const { fake, stop } = seed({}, {}, { failTask: false });
      expect(await stop()).toMatchObject({ stopped: 0 });
      expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ status: 'pending' });
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running' });
    });
  });
});

it('a Stop clears the prior attempt usage stamp on the reopened row', async () => {
  const { fake, step } = setup();
  await fake.db
    .update(schema.taskSteps)
    .set({
      contextLeftPercent: 40,
      contextTokens: 120000,
      contextWindowSize: 200000,
      usageFiveHourPct: 25,
      usageSevenDayPct: 50,
      usageDailyPct: 75,
    })
    .where(eq(schema.taskSteps.id, String(step.id)));
  await stopActiveCliInvocations(fake.db as never, TASK, { failTask: true });
  expect(fake.rows(schema.taskSteps).find((r) => r.id === step.id)).toMatchObject({
    status: 'failed',
    contextLeftPercent: null,
    contextTokens: null,
    contextWindowSize: null,
    usageFiveHourPct: null,
    usageSevenDayPct: null,
    usageDailyPct: null,
  });
});
