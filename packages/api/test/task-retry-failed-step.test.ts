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
import { TASK_JOB_NAMES, configService } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { reofferParkedSteps, settleActiveStepsIn } from '../src/lib/task-control.js';
import type { AppEnv } from '../src/context.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const DONE_ROW = '00000000-0000-4000-8000-0000000000c1';
const TARGET_ROW = '00000000-0000-4000-8000-0000000000c2';
const LATER_ROW = '00000000-0000-4000-8000-0000000000c3';
const RUN = '00000000-0000-4000-8000-0000000000d1';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);
vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');

beforeEach(() => {
  h.add.mockClear();
  h.kill.mockClear();
});

/** A task that failed on `step-b`, the second of three steps, with that row in `target`. */
function setup(target: Record<string, unknown>) {
  const fake = createFakeDb({
    modules: schema.modules,
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    taskStepCliChoices: schema.taskStepCliChoices,
  });
  fake.insert(schema.repositories, {
    id: USER,
    userId: USER,
    name: 'repo',
    source: 'git_https',
    status: 'ready',
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: USER,
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
  it('task retry clears a current pending receipt when recovery left no park marker', async () => {
    const t = setup({
      status: 'pending',
      waitingStartedAt: null,
      rerunGeneration: 2,
      applyReceipt: { id: 'recovered-current', kind: 'custom-migration', input: 'old-input' },
    });
    expect((await t.retry()).status).toBe(200);
    expect(t.step(TARGET_ROW)).toMatchObject({ applyReceipt: null, rerunGeneration: 3 });
  });

  it.each(['task retry', 'step retry', 'fanout resume'] as const)(
    '%s invalidates a downstream pending receipt left by recovery',
    async (action) => {
      const t = setup({ status: action === 'fanout resume' ? 'done' : 'failed' });
      t.fake.patch(schema.taskSteps, LATER_ROW, {
        applyReceipt: { id: 'recovered-apply', kind: 'custom-migration', input: 'old-input' },
        rerunGeneration: 2,
        detectOutput: { prior: true },
        formValues: { prior: true },
      });
      const fresh = t.fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: 'step-d',
        round: 0,
        stepIndex: 4,
        runSeq: 4,
        status: 'pending',
        rerunGeneration: 0,
      });
      const history = t.fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: 'step-c',
        round: 1,
        stepIndex: 3,
        runSeq: 3,
        status: 'pending',
        applyReceipt: { id: 'other-round', kind: 'custom-migration', input: 'other' },
      });
      if (action === 'fanout resume')
        t.fake.insert(schema.taskStepAgentMinings, {
          taskStepId: TARGET_ROW,
          agentId: 'reviewer',
          agentTitle: 'Reviewer',
          status: 'failed',
        });
      const res =
        action === 'task retry'
          ? await t.retry()
          : await app.request(`/${TASK}/steps/step-b/action`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: action === 'step retry' ? 'retry' : 'resume' }),
            });
      expect(res.status).toBe(200);
      expect(t.step(LATER_ROW)).toMatchObject({
        status: 'pending',
        applyReceipt: null,
        rerunGeneration: 3,
        detectOutput: null,
        formValues: null,
      });
      expect(t.step(fresh.id as string)).toMatchObject({ applyReceipt: null, rerunGeneration: 0 });
      expect(t.step(history.id as string).applyReceipt).toMatchObject({ id: 'other-round' });
    },
  );

  it.each(['reoffer', 'settle'] as const)(
    '%s clears receipts when reoffering a parked form',
    async (writer) => {
      const t = setup({
        status: 'waiting_form',
        applyReceipt: { id: 'old-apply', kind: 'custom-migration', input: 'command' },
        rerunGeneration: 2,
        formValues: { migrationCommand: 'node migrate.js' },
      });
      await t.fake.db.transaction(async (tx) => {
        if (writer === 'reoffer') await reofferParkedSteps(tx as never, TASK, t.fake.now(), []);
        else await settleActiveStepsIn(tx as never, TASK);
      });
      expect(t.step(TARGET_ROW)).toMatchObject({
        status: 'pending',
        applyReceipt: null,
        rerunGeneration: 3,
      });
    },
  );

  it('clears receipts when changing the default provider of a failed step', async () => {
    const t = setup({
      status: 'failed',
      iterationCount: 0,
      rerunGeneration: 2,
      applyReceipt: { id: 'old-apply', kind: 'custom-migration', input: 'command' },
    });
    const res = await app.request(`/${TASK}/steps/step-b/cli-provider`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliProviderId: null }),
    });
    expect(res.status).toBe(200);
    expect(t.step(TARGET_ROW)).toMatchObject({
      status: 'pending',
      applyReceipt: null,
      rerunGeneration: 3,
    });
  });

  it('AI retry clears the failed apply receipt without voiding the save generation or approved inputs', async () => {
    const inputs = { runMigration: true, migrationCommand: 'node migrate.js' };
    const t = setup({
      status: 'failed',
      errorMessage: 'column missing',
      applyReceipt: {
        id: 'failed-command',
        kind: 'custom-migration',
        input: 'command',
        result: { exitCode: 1 },
      },
      rerunGeneration: 4,
      detectOutput: { framework: 'unknown' },
      formValues: inputs,
    });
    const res = await app.request(`/${TASK}/steps/step-b/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry_ai' }),
    });
    expect(res.status).toBe(200);
    expect(t.step(TARGET_ROW)).toMatchObject({
      status: 'running',
      applyReceipt: null,
      rerunGeneration: 4,
      detectOutput: { framework: 'unknown' },
      formValues: inputs,
      aiFixContext: { priorError: 'column missing' },
    });
  });

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
    const at = t.fake.now().getTime();
    t.fake.patch(schema.taskSteps, TARGET_ROW, { waitingStartedAt: new Date(at - 60_000) });
    const res = await t.retry();
    expect(res.status).toBe(200);
    expect(t.step(TARGET_ROW)).toMatchObject({
      status: 'pending',
      waitingStartedAt: null,
      startedAt: null,
      idleMs: 0,
      carriedWorkMs: 0,
      carriedIdleMs: 60_000,
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
    const at = t.fake.now().getTime();
    t.fake.patch(schema.taskSteps, TARGET_ROW, {
      startedAt: new Date(at - 300_000),
      waitingStartedAt: new Date(at - 60_000),
      idleMs: 2_000,
      userActiveMs: 400,
      carriedWorkMs: 1_000,
      carriedIdleMs: 3_000,
      carriedUserActiveMs: 100,
    });
    expect((await t.retry()).status).toBe(200);
    expect(t.step(TARGET_ROW)).toMatchObject({
      status: 'pending',
      waitingStartedAt: null,
      startedAt: null,
      idleMs: 0,
      userActiveMs: 0,
      carriedWorkMs: 239_000,
      carriedIdleMs: 65_000,
      carriedUserActiveMs: 500,
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
