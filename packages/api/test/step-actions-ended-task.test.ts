import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
  kill: vi.fn(async (_taskId: string) => ({ killed: 0, killConfirmed: true })),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
import { seedStepCatalog } from './step-flags-fixture.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000d1';
const TASK = '00000000-0000-4000-8000-000000000001';
const STEP_ROW = '00000000-0000-4000-8000-0000000000c1';
const STEP = '11d-skill-sync';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.onError(errorHandler);
vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');

/** A task at `status` whose fan-out step failed with one agent left to re-run. */
function setup(status: string) {
  const fake = createFakeDb({
    modules: schema.modules,
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    stepCatalog: schema.stepCatalog,
  });
  seedStepCatalog(fake);
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    status,
    orchestrationEpoch: 3,
    currentStepId: STEP,
    currentRound: 0,
  });
  fake.insert(schema.taskSteps, {
    id: STEP_ROW,
    taskId: TASK,
    stepId: STEP,
    stepIndex: 1,
    runSeq: 1,
    round: 0,
    status: 'failed',
    errorMessage: 'boom',
    idleMs: 0,
  });
  fake.insert(schema.taskStepAgentMinings, {
    taskStepId: STEP_ROW,
    agentId: 'peer-reviewer',
    status: 'failed',
  });
  h.db = fake.db;
  return fake;
}

async function act(action: 'retry' | 'skip' | 'resume'): Promise<number> {
  const res = await app.request(`/${TASK}/steps/${STEP}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, round: 0 }),
  });
  return res.status;
}

describe('a step action on a task that has ended', () => {
  beforeEach(() => {
    h.add.mockClear();
    h.kill.mockClear();
  });

  it.each(['cancelled', 'completed'])(
    'refuses Retry, Skip and Resume on a %s task and changes nothing',
    async (status) => {
      for (const action of ['retry', 'skip', 'resume'] as const) {
        const fake = setup(status);
        expect(await act(action)).toBe(409);
        expect(fake.rows(schema.tasks)[0]).toMatchObject({ status, orchestrationEpoch: 3 });
        expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ status: 'failed' });
        expect(h.add).not.toHaveBeenCalled();
        expect(h.kill).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['retry', 'skip', 'resume'] as const)(
    'still moves a failed task back to the step on %s',
    async (action) => {
      const fake = setup('failed');
      expect(await act(action)).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({
        status: 'running',
        orchestrationEpoch: 4,
      });
      expect(h.add).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['workflow', 'custom-lsp-check'])(
    '%s Retry requires leaving completed and preserves its pinned run list',
    async (type) => {
      const fake = setup('completed');
      const snapshot = [STEP];
      fake.patch(schema.tasks, TASK, { type, runListSnapshot: snapshot });
      fake.patch(schema.taskSteps, STEP_ROW, { status: 'done' });
      expect(await act('retry')).toBe(409);
      expect(h.add).not.toHaveBeenCalled();
      expect(h.kill).not.toHaveBeenCalled();
      fake.patch(schema.tasks, TASK, { status: 'failed' });
      expect(await act('retry')).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({
        status: 'running',
        runListSnapshot: snapshot,
      });
      expect(h.add).toHaveBeenCalledTimes(1);
    },
  );

  it('answers 2xx, never 503, when the queue never answers after the row moved', async () => {
    const fake = setup('failed');
    h.add.mockImplementationOnce(() => new Promise(() => undefined));
    expect(await act('skip')).toBe(200);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running', orchestrationEpoch: 4 });
  }, 10_000);
});

it.each(['retry', 'skip', 'resume'] as const)(
  '%s exposes unconfirmed cleanup of active downstream work',
  async (action) => {
    const fake = setup('failed');
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: 'next',
      stepIndex: 2,
      runSeq: 2,
      round: 0,
      status: 'running',
    });
    h.kill.mockResolvedValueOnce({ killed: 0, killConfirmed: false });
    const res = await app.request(`/${TASK}/steps/${STEP}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    expect(res.status).toBe(200);
    expect(h.kill).toHaveBeenCalledWith(TASK);
    expect(await res.json()).toMatchObject({ ok: true, killed: 0, killConfirmed: false });
  },
);
