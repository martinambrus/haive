import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { Hono } from 'hono';
const h = vi.hoisted(() => ({ db: undefined as unknown, add: vi.fn() }));
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
beforeEach(() => h.add.mockClear());
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
