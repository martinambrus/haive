import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { Hono } from 'hono';
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async () => undefined),
  kill: vi.fn(async () => 0),
}));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(k: string, v: string): void }, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-4000-8000-000000000001');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true, getFresh: async () => 'normal' },
}));
import { definitionForCreate } from '../src/lib/task-type-definition.js';
import { markQueuedForStart } from '../src/lib/task-start.js';
import { seedStepCatalog } from './step-flags-fixture.js';
import { retryTaskAtStep } from '../src/routes/tasks/steps.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const USER = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
const empty = { version: 1, guardedSpans: [] };
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
const fixed = { ...empty, fixTarget: { stepId: 'report', capabilityVersion: 1 } };
function setup(contract: unknown = null) {
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
  fake.insert(schema.repositories, {
    id: USER,
    userId: USER,
    status: 'ready',
    name: 'repo',
    storagePath: '/unused/p6',
  });
  fake.insert(schema.taskTypeDefinitions, {
    slug: 'test',
    displayName: 'Test',
    source: 'admin',
    runListStrategy: 'static',
    stepIds: ['report'],
    enabled: true,
    selectable: true,
    requiresRepository: false,
    preAnswerDefaults: {},
    stepLoopLimitDefaults: {},
    promptSteps: {},
    executionContract: contract,
  });
  fake.insert(schema.stepCatalog, {
    stepId: 'report',
    source: 'core',
    workflowType: 'test',
    stepIndex: 1,
    composable: true,
    dispatchesCli: false,
    entry: {
      stepId: 'report',
      label: 'Report',
      group: 'test',
      requires: [],
      provides: [],
      dispatchesCli: false,
    },
  });
  return fake;
}
beforeEach(() => {
  h.add.mockClear();
  h.kill.mockClear();
});
it.each([guarded, fixed])(
  'create refuses unsupported contracts before task, event or queue writes',
  async (contract) => {
    const fake = setup(contract);
    const app = new Hono<AppEnv>();
    app.route('/tasks', taskRoutes);
    app.onError(errorHandler);
    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'test', title: 'Test', description: 'test' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'invalid-execution-contract',
      error: expect.stringContaining('not yet supported by this worker'),
    });
    expect(fake.rows(schema.tasks)).toEqual([]);
    expect(fake.rows(schema.taskEvents)).toEqual([]);
    expect(h.add).not.toHaveBeenCalled();
  },
);
it.each([guarded, fixed])(
  'START refuses a pinned active contract without changing a row, event or job',
  async (contract) => {
    const fake = setup();
    const task = fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      type: 'test',
      status: 'created',
      executionContract: contract,
    });
    await expect(markQueuedForStart(fake.db as never, TASK)).rejects.toThrow(
      'not yet supported by this worker',
    );
    expect(fake.rows(schema.tasks)).toEqual([task]);
    expect(fake.rows(schema.taskEvents)).toEqual([]);
    expect(h.add).not.toHaveBeenCalled();
  },
);
it('pins an inert valid contract with data edges on the locked INSERT and keeps it across definition edits', async () => {
  const fake = setup(empty);
  const app = new Hono<AppEnv>();
  app.route('/tasks', taskRoutes);
  app.onError(errorHandler);
  const result = await app.request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'test',
      title: 'Pinned',
      description: 'pinned',
      repositoryId: USER,
      deferStart: true,
    }),
  });
  expect(result.status, JSON.stringify(await result.json())).toBe(201);
  const task = fake.rows(schema.tasks)[0]!;
  expect(task.executionContract).toEqual(empty);
  expect(task.dataEdgePlan).toMatchObject({ version: 3 });
  await fake.db
    .update(schema.taskTypeDefinitions)
    .set({ executionContract: guarded })
    .where(eq(schema.taskTypeDefinitions.slug, 'test'));
  expect(fake.rows(schema.tasks)[0]!.executionContract).toEqual(empty);
  expect(result).toBeDefined();
});
it('plain static and unseeded builtins keep NULL contract semantics', async () => {
  const fake = setup();
  expect(
    (
      await fake.db.transaction((tx) =>
        definitionForCreate(tx as never, 'test', { generic: true, locked: true }),
      )
    ).executionContract,
  ).toBeNull();
  expect(
    (await definitionForCreate(fake.db as never, 'workflow', { generic: true, locked: true }))
      .executionContract ?? null,
  ).toBeNull();
});

const STEP = '11d-skill-sync';
const STEP_ROW = '00000000-0000-4000-8000-000000000003';
function stopped(contract: unknown, stepStatus: string = 'failed') {
  const fake = setup();
  seedStepCatalog(fake);
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
    executionContract: contract,
    pausedAt: new Date('2026-01-01'),
  });
  fake.insert(schema.taskSteps, {
    id: STEP_ROW,
    taskId: TASK,
    stepId: STEP,
    status: stepStatus,
    stepIndex: 1,
    runSeq: 1,
    round: 0,
    iterationCount: 1,
    iterations: [{ output: { summary: 'retained pass' } }],
    formSchema: { title: 'Answer', fields: [] },
    formValues: { kept: true },
    waitingStartedAt: new Date('2026-01-01'),
  });
  fake.insert(schema.taskSteps, {
    id: '00000000-0000-4000-8000-000000000004',
    taskId: TASK,
    stepId: 'report',
    status: 'waiting_cli',
    stepIndex: 2,
    runSeq: 2,
    round: 0,
  });
  fake.insert(schema.cliInvocations, {
    id: '00000000-0000-4000-8000-000000000005',
    taskId: TASK,
    taskStepId: STEP_ROW,
    mode: 'cli',
    prompt: 'test',
  });
  fake.insert(schema.taskStepAgentMinings, {
    taskStepId: STEP_ROW,
    agentId: 'peer-reviewer',
    status: 'failed',
    rawOutput: 'retained reply',
  });
  return fake;
}
function state(fake: ReturnType<typeof setup>) {
  return structuredClone([
    fake.rows(schema.tasks),
    fake.rows(schema.taskSteps),
    fake.rows(schema.cliInvocations),
    fake.rows(schema.taskStepAgentMinings),
    fake.rows(schema.taskEvents),
    fake.rows(schema.taskStepCliChoices),
  ]);
}
const requestCases: {
  label: string;
  path: string;
  body: Record<string, unknown>;
  method?: string;
  status?: string;
  taskStatus?: 'waiting_user';
}[] = [
  { label: 'task Retry at a step', path: '/action', body: { action: 'retry' } },
  ...['retry', 'resume', 'retry_ai', 'skip'].map((action) => ({
    label: `step ${action}`,
    path: `/steps/${STEP}/action`,
    body: { action, round: 0 },
  })),
  {
    label: 'form answer',
    path: `/steps/${STEP}/submit`,
    body: { values: { answer: 'go' } },
    status: 'waiting_form',
  },
  {
    label: 'clarification',
    path: `/steps/${STEP}/clarify`,
    body: { answer: 'go' },
    status: 'waiting_form',
  },
  {
    label: 'provider switch',
    path: `/steps/${STEP}/cli-provider`,
    method: 'PATCH',
    body: { cliProviderId: null, round: 0 },
  },
  {
    label: 'auto-continue wakeup',
    path: '',
    method: 'PATCH',
    body: { autoContinue: true },
    taskStatus: 'waiting_user',
  },
  { label: 'pause Resume', path: '/action', body: { action: 'resume' } },
];
for (const contract of [guarded, fixed, { version: 99 }]) {
  it.each(requestCases)(
    'refuses $label for an unsupported pin without side effects',
    async (test) => {
      const fake = stopped(contract, test.status);
      if (test.taskStatus)
        await fake.db
          .update(schema.tasks)
          .set({ status: test.taskStatus })
          .where(eq(schema.tasks.id, TASK));
      const before = state(fake);
      const app = new Hono<AppEnv>();
      app.route('/tasks', taskRoutes);
      app.onError(errorHandler);
      const res = await app.request(`/tasks/${TASK}${test.path}`, {
        method: test.method ?? 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(test.body),
      });
      expect(res.status, await res.clone().text()).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'invalid-execution-contract' });
      expect(state(fake)).toEqual(before);
      expect(h.kill).not.toHaveBeenCalled();
      expect(h.add).not.toHaveBeenCalled();
    },
  );
}
it('direct task-at-step Retry refuses before resetting or killing in-flight work', async () => {
  const fake = stopped(guarded);
  const before = state(fake);
  const target = fake.rows(schema.taskSteps)[0]!;
  await expect(
    retryTaskAtStep(fake.db as never, TASK, USER, target as never),
  ).rejects.toMatchObject({
    status: 409,
    code: 'invalid-execution-contract',
  });
  expect(state(fake)).toEqual(before);
  expect(h.kill).not.toHaveBeenCalled();
  expect(h.add).not.toHaveBeenCalled();
});

it.each([null, empty])('retains task-at-step Retry for a supported pin', async (contract) => {
  const fake = stopped(contract);
  await expect(
    retryTaskAtStep(fake.db as never, TASK, USER, fake.rows(schema.taskSteps)[0]! as never),
  ).resolves.toEqual({ epoch: 4 });
  expect(fake.rows(schema.tasks)[0]).toMatchObject({
    status: 'running',
    executionContract: contract,
  });
  expect(h.kill).toHaveBeenCalledTimes(1);
  expect(h.add).toHaveBeenCalledTimes(1);
});

it('allows Stop on an unsupported mid-span task but refuses the following Resume', async () => {
  const midSpan = {
    ...guarded,
    guardedSpans: [{ ...guarded.guardedSpans[0]!, firstStepId: STEP }],
  };
  const fake = stopped(midSpan, 'running');
  await fake.db.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, TASK));
  const app = new Hono<AppEnv>();
  app.route('/tasks', taskRoutes);
  app.onError(errorHandler);
  const stop = await app.request(`/tasks/${TASK}/cancel-active-cli`, { method: 'POST' });
  expect(stop.status, await stop.clone().text()).toBe(200);
  expect(fake.rows(schema.tasks)[0]).toMatchObject({
    status: 'failed',
    executionContract: midSpan,
  });
  expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ status: 'failed' });
  const before = state(fake);
  h.kill.mockClear();
  h.add.mockClear();
  const resume = await app.request(`/tasks/${TASK}/steps/${STEP}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resume', round: 0 }),
  });
  expect(resume.status).toBe(409);
  expect(await resume.json()).toMatchObject({ code: 'invalid-execution-contract' });
  expect(state(fake)).toEqual(before);
  expect(h.kill).not.toHaveBeenCalled();
  expect(h.add).not.toHaveBeenCalled();
});

it.each([
  { label: 'task Cancel', path: '/action', action: 'cancel' },
  { label: 'step Abort', path: `/steps/${STEP}/action`, action: 'abort' },
])('keeps $label available on a guarded pin', async ({ path, action }) => {
  const fake = stopped(guarded, 'running');
  await fake.db.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, TASK));
  const app = new Hono<AppEnv>();
  app.route('/tasks', taskRoutes);
  app.onError(errorHandler);
  const res = await app.request(`/tasks/${TASK}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, round: 0 }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(fake.rows(schema.tasks)[0]).toMatchObject({
    status: 'cancelled',
    executionContract: guarded,
  });
  expect(h.add).toHaveBeenCalledWith(
    'cancel-task',
    expect.objectContaining({ taskId: TASK }),
    expect.anything(),
  );
});
