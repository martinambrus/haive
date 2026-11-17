import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  paused: false,
  add: vi.fn(async (..._args: unknown[]) => undefined),
  kill: vi.fn(async (_taskId: string) => 0),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(k: string, v: string): void }, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-4000-8000-000000000001');
    c.set('userRole', 'admin');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@haive/shared', async (original) => {
  const shared = await original<typeof import('@haive/shared')>();
  return {
    ...shared,
    configService: {
      getBoolean: async () => true,
      getFresh: async (key: string) =>
        key === shared.CONFIG_KEYS.GLOBAL_PAUSE ? String(h.paused) : 'normal',
      set: async (key: string, value: string) => {
        if (key === shared.CONFIG_KEYS.GLOBAL_PAUSE) h.paused = value === 'true';
      },
    },
  };
});
// The one allowed stand-in for the fence: a frozen copy of the pre-change shared function,
// which is what an API built before the guarded-span admission still runs against a new worker.
vi.mock('@haive/shared/modularity', async (original) => {
  const actual = await original<typeof import('@haive/shared/modularity')>();
  return {
    ...actual,
    assertExecutionContractSupported: (raw: unknown): void => {
      if (raw == null) return;
      const contract = actual.parseExecutionContract(raw);
      if (contract.guardedSpans.length || contract.fixTarget) {
        throw new actual.ExecutionContractError(
          'guarded spans or custom fix target not yet supported by this worker',
        );
      }
    },
  };
});

import { markQueuedForStart } from '../src/lib/task-start.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
import { seedStepCatalog } from './step-flags-fixture.js';

const USER = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
const STEP_ROW = '00000000-0000-4000-8000-000000000003';
const STEP = '11d-skill-sync';
const STAMP = new Date('2026-01-01');
const guarded = {
  version: 1,
  guardedSpans: [
    {
      id: 'a',
      firstStepId: 'report',
      lastStepId: 'report',
      predicateId: 'module.fx.planned',
      args: {},
    },
  ],
};

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/admin/maintenance', maintenanceRoutes);
app.route('/admin', adminRoutes);
app.onError(errorHandler);

beforeEach(() => {
  h.paused = false;
  h.add.mockClear();
  h.kill.mockClear();
});

function setup(task: Record<string, unknown> = {}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskTypeDefinitions: schema.taskTypeDefinitions,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    taskDatabaseStates: schema.taskDatabaseStates,
    mergeDirClaims: schema.mergeDirClaims,
    stepCatalog: schema.stepCatalog,
    modules: schema.modules,
    repositories: schema.repositories,
    taskAttachments: schema.taskAttachments,
    auditEvents: schema.auditEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    taskStepCliChoices: schema.taskStepCliChoices,
  });
  h.db = fake.db;
  seedStepCatalog(fake);
  fake.insert(schema.repositories, {
    id: USER,
    userId: USER,
    status: 'ready',
    name: 'repo',
    storagePath: '/unused/skew',
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: USER,
    type: 'test',
    status: 'failed',
    orchestrationEpoch: 3,
    currentStepId: STEP,
    currentRound: 0,
    runListSnapshot: [STEP, 'report'],
    executionContract: guarded,
    ...task,
  });
  fake.insert(schema.taskSteps, {
    id: STEP_ROW,
    taskId: TASK,
    stepId: STEP,
    status: 'failed',
    stepIndex: 1,
    runSeq: 1,
    round: 0,
  });
  const snapshot = () =>
    JSON.stringify([
      fake.rows(schema.tasks),
      fake.rows(schema.taskSteps),
      fake.rows(schema.taskEvents),
      fake.rows(schema.auditEvents),
    ]);
  return { fake, snapshot };
}
const post = (path: string, body: unknown, method = 'POST') =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

it('an old API refuses START of a guarded task', async () => {
  const t = setup({ status: 'created' });
  const before = t.snapshot();
  await expect(markQueuedForStart(t.fake.db as never, TASK)).rejects.toMatchObject({
    status: 409,
    code: 'invalid-execution-contract',
  });
  expect(t.snapshot()).toBe(before);
  expect(h.add).not.toHaveBeenCalled();
});

it.each([
  ['task Retry', `/tasks/${TASK}/action`, { action: 'retry' }, {}],
  ['step Retry', `/tasks/${TASK}/steps/${STEP}/action`, { action: 'retry', round: 0 }, {}],
  [
    'owner Resume',
    `/tasks/${TASK}/action`,
    { action: 'resume' },
    { status: 'running', pausedAt: STAMP },
  ],
])(
  'an old API refuses %s of a guarded task and changes nothing',
  async (_label, path, body, over) => {
    const t = setup(over);
    const before = t.snapshot();
    const res = await post(path, body);
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'invalid-execution-contract' });
    expect(t.snapshot()).toBe(before);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  },
);

it('an old API global-pause lift holds a guarded task and lists it in skippedTasks', async () => {
  const t = setup({ status: 'queued' });
  h.paused = true;
  const res = await post('/admin/config/global-pause', { paused: false }, 'PUT');
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await res.json()).toEqual({
    paused: false,
    skippedTasks: [
      { taskId: TASK, code: 'invalid-execution-contract', reason: expect.any(String) },
    ],
  });
  expect(t.fake.rows(schema.tasks)[0]!.pausedAt).toBeInstanceOf(Date);
  expect(t.fake.rows(schema.taskEvents).map((e) => e.eventType)).toEqual(['task.paused']);
  expect(h.add).not.toHaveBeenCalled();
  expect(h.kill).not.toHaveBeenCalled();
});

it('an old API admin Resume refuses a guarded task and changes nothing', async () => {
  const t = setup({ status: 'running', pausedAt: STAMP });
  const before = t.snapshot();
  const res = await post(`/admin/maintenance/tasks/${TASK}/action`, { action: 'resume' });
  expect(res.status, await res.clone().text()).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'invalid-execution-contract' });
  expect(t.snapshot()).toBe(before);
});
