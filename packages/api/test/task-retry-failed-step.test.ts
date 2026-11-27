import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
  kill: vi.fn(async (_taskId: string) => ({ killed: 0, killConfirmed: true })),
  guardPin: false,
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
  h.guardPin = false;
  h.add.mockClear();
  h.kill.mockClear();
});

/** A task that failed on `step-b`, the second of three steps, with that row in `target`. */
function setup(target: Record<string, unknown>) {
  const fake = createFakeDb({
    modules: schema.modules,
    stepCatalog: schema.stepCatalog,
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    taskStepCliChoices: schema.taskStepCliChoices,
    taskDatabaseStates: schema.taskDatabaseStates,
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
    executionContract: h.guardPin
      ? {
          version: 1,
          guardedSpans: [
            {
              id: 'work',
              firstStepId: 'step-c',
              lastStepId: 'step-d',
              predicateId: 'module.fx.guard',
              args: {},
            },
          ],
        }
      : null,
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
  it.each(['failed', 'waiting_form', 'pending'] as const)(
    'a CLI switch clears prior attempt warnings on a %s step',
    async (status) => {
      const t = setup({
        status,
        iterationCount: 0,
        warningMessage: 'This task continues on codex exec. Attempt 1 was rejected.',
        rerunGeneration: 2,
      });
      t.fake.insert(schema.cliInvocations, {
        id: RUN,
        taskId: TASK,
        taskStepId: TARGET_ROW,
        supersededAt: null,
      });
      const res = await app.request(`/${TASK}/steps/step-b/cli-provider`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliProviderId: null }),
      });
      expect(res.status).toBe(200);
      expect(t.step(TARGET_ROW)).toMatchObject({
        status: 'pending',
        warningMessage: null,
        rerunGeneration: 3,
      });
      expect(t.fake.rows(schema.cliInvocations)[0]!.supersededAt).toBeInstanceOf(Date);
    },
  );

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

  it.each([
    'task retry',
    'step retry',
    'fanout resume',
    'loop resume',
    'retry_ai',
    'provider switch',
    'pending provider switch',
  ] as const)(
    '%s invalidates a downstream pending save decision without an apply receipt',
    async (action) => {
      const t = setup({
        status:
          action === 'fanout resume'
            ? 'done'
            : action === 'pending provider switch'
              ? 'pending'
              : 'failed',
        iterationCount: action === 'loop resume' ? 1 : 0,
      });
      t.fake.patch(schema.taskSteps, LATER_ROW, {
        stepId: '11g-save-database',
        rerunGeneration: 2,
      });
      t.fake.insert(schema.taskDatabaseStates, {
        taskId: TASK,
        repositoryId: USER,
        outcome: 'saved',
        candidateStepId: LATER_ROW,
        decisionGeneration: 2,
      });
      const history = t.fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: '11g-save-database',
        stepIndex: 3,
        runSeq: 3,
        round: 1,
        status: 'pending',
        rerunGeneration: 2,
      });
      const fresh = t.fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: 'fresh',
        stepIndex: 4,
        runSeq: 4,
        round: 0,
        status: 'pending',
        rerunGeneration: 0,
      });
      const switching = action === 'provider switch' || action === 'pending provider switch';
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
          : await app.request(
              switching ? `/${TASK}/steps/step-b/cli-provider` : `/${TASK}/steps/step-b/action`,
              {
                method: switching ? 'PATCH' : 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(
                  switching
                    ? { cliProviderId: null }
                    : {
                        action:
                          action === 'step retry'
                            ? 'retry'
                            : action === 'retry_ai'
                              ? 'retry_ai'
                              : 'resume',
                      },
                ),
              },
            );
      expect(res.status).toBe(200);
      expect(t.step(LATER_ROW)).toMatchObject({
        status: 'pending',
        applyReceipt: null,
        rerunGeneration: 3,
      });
      expect(t.step(history.id as string).rerunGeneration).toBe(2);
      expect(t.step(fresh.id as string).rerunGeneration).toBe(0);
    },
  );

  it('task retry invalidates a current pending save decision without a park or receipt', async () => {
    const t = setup({ status: 'pending', stepId: '11g-save-database', rerunGeneration: 2 });
    t.fake.patch(schema.tasks, TASK, { currentStepId: '11g-save-database' });
    t.fake.insert(schema.taskDatabaseStates, {
      taskId: TASK,
      repositoryId: USER,
      outcome: 'saved',
      candidateStepId: TARGET_ROW,
      decisionGeneration: 2,
    });
    expect((await t.retry()).status).toBe(200);
    expect(t.step(TARGET_ROW).rerunGeneration).toBe(3);
  });

  it.each(['reoffer', 'settle'] as const)(
    '%s clears receipts when reoffering a parked form',
    async (writer) => {
      const t = setup({
        status: 'waiting_form',
        applyReceipt: { id: 'old-apply', kind: 'custom-migration', input: 'command' },
        rerunGeneration: 2,
        formValues: { migrationCommand: 'node migrate.js' },
      });
      t.fake.patch(schema.taskSteps, LATER_ROW, {
        stepId: '11g-save-database',
        rerunGeneration: 2,
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
      expect(t.step(LATER_ROW).rerunGeneration).toBe(writer === 'settle' ? 3 : 2);
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
    h.kill.mockResolvedValueOnce({ killed: 0, killConfirmed: false });
    const response = await t.retry();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ killed: 0, killConfirmed: false });
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

// Storage-level reset controls under a guarded pin, through the real admission gate.
describe('guard storage on task Retry', () => {
  beforeEach(() => {
    h.guardPin = true;
  });
  it.each(['retry_ai', 'resume'] as const)(
    '%s distinguishes a new rerun from recovery of stored decisions',
    async (action) => {
      const t = setup({ status: 'failed', iterationCount: 1, iterations: [] });
      t.fake.patch(schema.taskSteps, LATER_ROW, { guardState: { run: false }, rerunGeneration: 2 });
      const response = await app.request(`/${TASK}/steps/step-b/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, round: 0 }),
      });
      expect(response.status).toBe(200);
      expect(t.step(LATER_ROW)).toMatchObject(
        action === 'resume'
          ? { guardState: { run: false }, rerunGeneration: 2 }
          : { guardState: null, rerunGeneration: 3 },
      );
    },
  );
  it('clears pending forward decisions, preserving another round', async () => {
    const t = setup({ status: 'failed' });
    t.fake.patch(schema.taskSteps, LATER_ROW, { guardState: { run: false }, rerunGeneration: 4 });
    const history = t.fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: 'step-c',
      title: 'history',
      round: 1,
      runSeq: 3,
      stepIndex: 3,
      status: 'pending',
      guardState: { run: true },
      rerunGeneration: 2,
    });
    expect((await t.retry()).status).toBe(200);
    expect(t.step(LATER_ROW)).toMatchObject({
      status: 'pending',
      guardState: null,
      rerunGeneration: 5,
    });
    expect(t.step(history.id as string)).toMatchObject({
      guardState: { run: true },
      rerunGeneration: 2,
    });
  });
  it('a full START restart clears stored branches and their skips', async () => {
    const t = setup({ status: 'pending' });
    t.fake.patch(schema.tasks, TASK, { currentStepId: null });
    t.fake.patch(schema.taskSteps, TARGET_ROW, { guardState: { run: false }, rerunGeneration: 4 });
    t.fake.patch(schema.taskSteps, LATER_ROW, {
      status: 'skipped',
      guardState: { kind: 'guard-skip' },
      rerunGeneration: 7,
    });
    expect((await t.retry()).status).toBe(200);
    expect(t.step(TARGET_ROW)).toMatchObject({
      status: 'pending',
      guardState: null,
      rerunGeneration: 5,
    });
    expect(t.step(LATER_ROW)).toMatchObject({
      status: 'pending',
      guardState: null,
      rerunGeneration: 8,
    });
    expect(queued()).toEqual([{ name: TASK_JOB_NAMES.START, data: expect.any(Object) }]);
  });
});

describe('guard reset review controls', () => {
  it.each(['skipped', 'done'] as const)(
    'F1 Resume regenerates the producer and invalidates a %s entry and owned skips',
    async (status) => {
      h.guardPin = true;
      const t = setup({ status: 'done', degradedNote: 'partial agents' });
      t.fake.patch(schema.taskSteps, LATER_ROW, { status: 'done', rerunGeneration: 2 });
      const entry = t.fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: 'step-d',
        stepIndex: 4,
        runSeq: 4,
        round: 0,
        status,
        guardState: { run: false },
        rerunGeneration: 3,
      });
      const member = t.fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: 'step-e',
        stepIndex: 5,
        runSeq: 5,
        round: 0,
        status: 'skipped',
        guardState: { kind: 'guard-skip' },
        rerunGeneration: 4,
      });
      const retained = t.fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: 'retained',
        stepIndex: 1,
        runSeq: 1,
        round: 1,
        status: 'running',
        guardState: { run: true },
        rerunGeneration: 8,
      });
      t.fake.insert(schema.taskStepAgentMinings, {
        taskStepId: TARGET_ROW,
        agentId: 'reviewer',
        agentTitle: 'Reviewer',
        status: 'failed',
      });
      const response = await app.request(`/${TASK}/steps/step-b/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resume' }),
      });
      expect(response.status).toBe(200);
      expect(t.step(retained.id as string)).toMatchObject({
        status: 'pending',
        guardState: { run: true },
        rerunGeneration: 8,
      });
      expect(t.step(LATER_ROW)).toMatchObject({ status: 'pending', rerunGeneration: 3 });
      expect(t.step(entry.id as string)).toMatchObject({
        status: 'pending',
        guardState: null,
        rerunGeneration: 4,
      });
      expect(t.step(member.id as string)).toMatchObject({
        status: 'pending',
        guardState: null,
        rerunGeneration: 5,
      });
    },
  );
  it.each(['task retry', 'step retry', 'pending provider switch'] as const)(
    'F4 %s kills the sandbox of an extra guard row activated after selection',
    async (action) => {
      h.guardPin = true;
      const switching = action === 'pending provider switch';
      const t = setup({ status: switching ? 'pending' : 'failed', iterationCount: 0 });
      if (switching)
        t.fake.patch(schema.taskSteps, LATER_ROW, {
          applyReceipt: { kind: 'custom-migration', id: 'old' },
        });
      const extra = switching
        ? t.fake.insert(schema.taskSteps, {
            taskId: TASK,
            stepId: 'step-d',
            rerunGeneration: 0,
            stepIndex: 4,
            runSeq: 4,
            round: 0,
            status: 'pending',
          })
        : t.step(LATER_ROW);
      let claimed = false;
      t.fake.hooks.beforeUpdate = (table) => {
        if (table !== schema.cliInvocations || claimed) return;
        claimed = true;
        t.fake.patch(schema.taskSteps, extra.id as string, {
          status: 'running',
          guardState: { run: true },
        });
      };
      const response =
        action === 'task retry'
          ? await t.retry()
          : await app.request(`/${TASK}/steps/step-b/${switching ? 'cli-provider' : 'action'}`, {
              method: switching ? 'PATCH' : 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                switching ? { cliProviderId: null, remember: false } : { action: 'retry' },
              ),
            });
      expect(response.status).toBe(200);
      expect(t.step(extra.id as string)).toMatchObject({
        status: 'pending',
        guardState: null,
        rerunGeneration: 1,
      });
      expect(h.kill).toHaveBeenCalledWith(TASK);
      const eventType =
        action === 'task retry'
          ? 'task.retried'
          : switching
            ? 'step.cli_provider_preference_changed'
            : 'step.retry';
      const selected = expect.arrayContaining([{ stepId: extra.stepId, round: 0 }]);
      expect(
        t.fake.rows(schema.taskEvents).find((r) => r.eventType === eventType)?.payload,
      ).toEqual(
        expect.objectContaining(
          action === 'task retry' ? { reset: selected } : { leftActive: selected },
        ),
      );
      if (switching) expect(h.add).not.toHaveBeenCalled();
    },
  );
  it.each(['reoffer', 'settle'] as const)(
    'F5 %s clears a guard state when it advances its generation',
    async (action) => {
      h.guardPin = true;
      const t = setup({ status: 'waiting_form', guardState: { run: true }, rerunGeneration: 4 });
      await t.fake.db.transaction((tx) =>
        action === 'reoffer'
          ? reofferParkedSteps(tx as never, TASK, new Date(), [])
          : settleActiveStepsIn(tx as never, TASK),
      );
      expect(t.step(TARGET_ROW)).toMatchObject({
        status: 'pending',
        guardState: null,
        rerunGeneration: 5,
      });
    },
  );
});

it.each([null, { version: 1, guardedSpans: [] }])(
  'F2 ordinary START Retry adds no full step-row SELECT: %j',
  async (executionContract) => {
    const t = setup({ status: 'pending' });
    t.fake.patch(schema.tasks, TASK, { currentStepId: null, executionContract });
    const reads: unknown[] = [];
    const writes: object[] = [];
    const transaction = t.fake.db.transaction.bind(t.fake.db);
    vi.spyOn(t.fake.db, 'transaction').mockImplementation((fn) =>
      transaction((tx) => {
        const select = tx.select.bind(tx);
        const handle = {
          ...tx,
          update: (table: never) => ({
            set: (values: never) => {
              if (table === schema.taskSteps) writes.push(values);
              return tx.update(table).set(values);
            },
          }),
          select: (fields?: never) => ({
            from: (table: never) => {
              if (
                (table === schema.taskSteps && fields == null) ||
                (table === schema.tasks && Object.keys(fields ?? {}).includes('executionContract'))
              )
                reads.push(table);
              return select(fields).from(table);
            },
          }),
        };
        return fn(handle as never);
      }),
    );
    expect((await t.retry()).status).toBe(200);
    expect(reads).toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
    for (const values of writes) expect(values).not.toHaveProperty('guardState');
  },
);

it.each(['task', 'step'] as const)(
  'LSP final evidence follows real %s Retry reset sets without losing retained references',
  async (action) => {
    for (const targetIndex of [0, 2, 3]) {
      const t = setup({ status: 'failed' });
      await t.fake.db.delete(schema.taskSteps).where(eq(schema.taskSteps.taskId, TASK));
      const sequence = [
        '04-verify-environment',
        '01-worktree-setup',
        '01b-install-plugins',
        '01b1-verify-composed-lsp',
      ];
      const rows = sequence.map((stepId, index) =>
        t.fake.insert(schema.taskSteps, {
          taskId: TASK,
          stepId,
          round: 0,
          runSeq: index + 4,
          stepIndex: index === 0 ? 204 : 101 + index / 10,
          status: index === targetIndex ? 'failed' : 'done',
          rerunGeneration: 0,
          output: { evidence: stepId },
          endedAt: t.fake.now(),
        }),
      );
      t.fake.patch(schema.tasks, TASK, {
        currentStepId: sequence[targetIndex],
        currentRound: 0,
        metadata: {
          unrelated: true,
          composedLspImageRefs: { effective: 'keep', prior: 'keep', verifying: 'keep' },
        },
      });
      const metadata = structuredClone(t.task().metadata);
      const response =
        action === 'task'
          ? await t.retry()
          : await app.request(`/${TASK}/steps/${sequence[targetIndex]}/action`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'retry', round: 0 }),
            });
      expect(response.status).toBe(200);
      expect(
        t.fake
          .rows(schema.taskSteps)
          .filter((r) => r.status === 'pending')
          .map((r) => r.stepId),
      ).toEqual(sequence.slice(targetIndex));
      for (const row of rows.slice(targetIndex))
        expect(t.step(String(row.id))).toMatchObject({ output: null, rerunGeneration: 1 });
      for (const row of rows.slice(0, targetIndex))
        expect(t.step(String(row.id)).output).toEqual(row.output);
      expect(t.task().metadata).toEqual(metadata);
    }
  },
);
