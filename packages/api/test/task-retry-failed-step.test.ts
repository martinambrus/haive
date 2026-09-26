import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
  kill: vi.fn(async (_taskId: string) => 0),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { TASK_JOB_NAMES } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const DONE_ROW = '00000000-0000-4000-8000-0000000000c1';
const TARGET_ROW = '00000000-0000-4000-8000-0000000000c2';
const LATER_ROW = '00000000-0000-4000-8000-0000000000c3';
const RUN = '00000000-0000-4000-8000-0000000000d1';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

beforeEach(() => {
  h.add.mockClear();
  h.kill.mockClear();
});

/** A task that failed on `step-b`, the second of three steps, with that row in `target`. */
function setup(target: Record<string, unknown>) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status: 'failed',
    errorMessage: 'boom',
    orchestrationEpoch: 3,
    currentStepId: 'step-b',
    currentRound: 0,
    completedAt: fake.now(),
  });
  const row = (id: string, stepId: string, runSeq: number, values: Record<string, unknown>) =>
    fake.insert(schema.taskSteps, {
      id,
      taskId: TASK,
      stepId,
      stepIndex: runSeq,
      runSeq,
      round: 0,
      title: stepId,
      idleMs: 0,
      carriedWorkMs: 0,
      carriedIdleMs: 0,
      carriedUserActiveMs: 0,
      userActiveMs: 0,
      ...values,
    });
  row(DONE_ROW, 'step-a', 1, { status: 'done', output: { a: 1 } });
  row(TARGET_ROW, 'step-b', 2, target);
  row(LATER_ROW, 'step-c', 3, { status: 'pending' });
  h.db = fake.db;
  const retry = () =>
    app.request(`/${TASK}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
  const step = (id: string) => fake.rows(schema.taskSteps).find((r) => r.id === id)!;
  const task = () => fake.rows(schema.tasks)[0]!;
  return { fake, retry, step, task };
}

const queued = () => h.add.mock.calls.map(([name, data]) => ({ name, data }));

describe('a task Retry re-runs the step the task stopped on', () => {
  it('resets the failed row and advances to it at a new epoch, with no START', async () => {
    const t = setup({
      status: 'failed',
      errorMessage: 'kaboom',
      detectOutput: { seen: true },
      formSchema: { title: 'f', fields: [] },
      output: { partial: true },
    });
    const res = await t.retry();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'running' });
    expect(t.step(TARGET_ROW)).toMatchObject({
      status: 'pending',
      detectOutput: null,
      formSchema: null,
      output: null,
      errorMessage: null,
    });
    expect(t.step(DONE_ROW)).toMatchObject({ status: 'done', output: { a: 1 } });
    expect(t.task()).toMatchObject({
      status: 'running',
      currentStepId: 'step-b',
      orchestrationEpoch: 4,
      errorMessage: null,
      completedAt: null,
    });
    expect(queued()).toEqual([
      {
        name: TASK_JOB_NAMES.ADVANCE_STEP,
        data: expect.objectContaining({ stepId: 'step-b', round: 0, epoch: 4 }),
      },
    ]);
  });

  it('changes nothing when a Cancel lands before the task is moved', async () => {
    const t = setup({ status: 'failed', errorMessage: 'kaboom', detectOutput: { seen: true } });
    t.fake.hooks.beforeUpdate = (table) => {
      if (table !== schema.tasks) return;
      t.fake.hooks.beforeUpdate = null;
      t.fake.patch(schema.tasks, TASK, { status: 'cancelled' });
    };
    const res = await t.retry();
    expect(res.status).toBe(409);
    expect(t.task()).toMatchObject({ status: 'cancelled', orchestrationEpoch: 3 });
    expect(t.step(TARGET_ROW)).toMatchObject({ status: 'failed', detectOutput: { seen: true } });
    expect(queued()).toEqual([]);
    expect(h.kill).not.toHaveBeenCalled();
  });

  it('re-offers a runtime park as it was rather than failing it', async () => {
    const t = setup({
      status: 'pending',
      waitingStartedAt: new Date(Date.now() - 60_000),
      statusMessage: 'Waiting for a free runtime slot',
      detectOutput: { seen: true },
    });
    const res = await t.retry();
    expect(res.status).toBe(200);
    expect(t.step(TARGET_ROW)).toMatchObject({
      status: 'pending',
      waitingStartedAt: null,
      statusMessage: null,
      detectOutput: { seen: true },
    });
    expect(queued()).toEqual([
      { name: TASK_JOB_NAMES.ADVANCE_STEP, data: expect.objectContaining({ stepId: 'step-b' }) },
    ]);
  });

  it('re-offers a form the task stopped on with its form', async () => {
    const form = { title: 'f', fields: [] };
    const t = setup({
      status: 'waiting_form',
      waitingStartedAt: new Date(),
      detectOutput: { seen: true },
      formSchema: form,
    });
    expect((await t.retry()).status).toBe(200);
    expect(t.step(TARGET_ROW)).toMatchObject({
      status: 'pending',
      waitingStartedAt: null,
      formSchema: form,
      detectOutput: { seen: true },
    });
  });

  it('ends a live run and kills the sandboxes once the reset commits', async () => {
    const t = setup({ status: 'waiting_cli', startedAt: new Date() });
    t.fake.insert(schema.cliInvocations, {
      id: RUN,
      taskId: TASK,
      taskStepId: TARGET_ROW,
      mode: 'cli',
      prompt: 'p',
      startedAt: t.fake.now(),
    });
    expect((await t.retry()).status).toBe(200);
    const run = t.fake.rows(schema.cliInvocations)[0]!;
    expect(run.supersededAt).not.toBeNull();
    expect(run.endedAt).not.toBeNull();
    expect(t.step(TARGET_ROW)).toMatchObject({ status: 'pending' });
    expect(h.kill).toHaveBeenCalledTimes(1);
  });

  it('leaves a finished row for its advance to re-drive the hand-off', async () => {
    const t = setup({ status: 'done', output: { b: 2 } });
    expect((await t.retry()).status).toBe(200);
    expect(t.step(TARGET_ROW)).toMatchObject({ status: 'done', output: { b: 2 } });
    expect(queued()).toEqual([
      { name: TASK_JOB_NAMES.ADVANCE_STEP, data: expect.objectContaining({ stepId: 'step-b' }) },
    ]);
  });
});
