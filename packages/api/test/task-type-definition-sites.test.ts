import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  definition: vi.fn(
    async (..._args: unknown[]) => ({ runListSnapshot: ['00-x', '01-y'] }) as unknown,
  ),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/task-type-definition.js', () => ({ definitionForCreate: h.definition }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
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
import { taskRoutes } from '../src/routes/tasks/index.js';
import { upgradeRoutes } from '../src/routes/upgrades.js';
import { spawnPlanTask } from '../src/lib/spawn-plan-task.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { HttpError } from '../src/context.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const SNAPSHOT = ['00-x', '01-y'];

const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set('maintenanceState', 'normal');
  await next();
});
app.route('/tasks', taskRoutes);
app.route('/repositories', upgradeRoutes);
app.onError(errorHandler);

function world() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateConflicts: schema.projectStateConflicts,
    taskDatabaseStates: schema.taskDatabaseStates,
    repositoryDatabaseStates: schema.repositoryDatabaseStates,
    databaseSnapshots: schema.databaseSnapshots,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  fake.insert(schema.tasks, {
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding',
    title: 'onboarding',
    status: 'completed',
    completedAt: new Date(0),
  });
  const prior = fake.insert(schema.tasks, {
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding_upgrade',
    title: 'upgrade',
    status: 'completed',
    completedAt: new Date(1),
  });
  h.db = fake.db;
  const created = () =>
    fake.rows(schema.tasks).filter((r) => r.status !== 'completed' && r.repositoryId === REPO);
  return { fake, created, prior };
}

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
  h.definition.mockClear();
});

describe('POST /tasks pins the run list', () => {
  it.each(['workflow', 'onboarding', 'onboarding_upgrade'] as const)(
    'writes the helper snapshot into a %s row, looked up generically',
    async (type) => {
      const { created } = world();
      const res = await post('/tasks', {
        type,
        title: 't',
        description: 'do it',
        repositoryId: REPO,
      });
      expect(res.status).toBe(201);
      expect(h.definition).toHaveBeenCalledWith(expect.anything(), type, { generic: true });
      expect(created()).toHaveLength(1);
      expect(created()[0]).toMatchObject({ type, runListSnapshot: SNAPSHOT });
    },
  );

  it('stores a null snapshot when the helper returns none', async () => {
    const { created } = world();
    h.definition.mockResolvedValueOnce({ runListSnapshot: null });
    h.definition.mockResolvedValueOnce({ runListSnapshot: null });
    expect(
      (await post('/tasks', { type: 'workflow', title: 't', description: 'd', repositoryId: REPO }))
        .status,
    ).toBe(201);
    expect(created()[0]).toMatchObject({ runListSnapshot: null });
  });

  it('creates nothing when the type is refused', async () => {
    const { created } = world();
    h.definition.mockRejectedValueOnce(new HttpError(403, 'Task type workflow is disabled'));
    const res = await post('/tasks', {
      type: 'workflow',
      title: 't',
      description: 'd',
      repositoryId: REPO,
    });
    expect(res.status).toBe(403);
    expect(created()).toHaveLength(0);
  });
});

describe('the rollback pins the run list', () => {
  it('writes the helper snapshot into the rollback row, looked up non-generically', async () => {
    const { created } = world();
    const res = await post(`/repositories/${REPO}/rollback-upgrade`);
    expect(res.status).toBe(201);
    expect(h.definition).toHaveBeenCalledWith(expect.anything(), 'onboarding_upgrade', {
      generic: false,
    });
    expect(created()[0]).toMatchObject({ runListSnapshot: SNAPSHOT });
  });
});

describe('spawnPlanTask pins the run list', () => {
  it.each(['plan_build', 'plan_chat', 'advisory', 'plan_sequence', 'plan_merge'] as const)(
    'writes the helper snapshot into a %s row',
    async (type) => {
      const fake = createFakeDb({ tasks: schema.tasks });
      await spawnPlanTask({
        db: fake.db as never,
        userId: USER,
        repositoryId: REPO,
        type,
        title: 'x',
        metadata: {},
        cliProviderId: null,
        enqueue: false,
      });
      expect(h.definition).toHaveBeenCalledWith(fake.db, type, { generic: false });
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ type, runListSnapshot: SNAPSHOT });
    },
  );

  it('inserts nothing when the type is refused', async () => {
    const fake = createFakeDb({ tasks: schema.tasks });
    h.definition.mockRejectedValueOnce(new HttpError(403, 'Task type plan_chat is disabled'));
    await expect(
      spawnPlanTask({
        db: fake.db as never,
        userId: USER,
        repositoryId: REPO,
        type: 'plan_chat',
        title: 'x',
        metadata: {},
        cliProviderId: null,
        enqueue: false,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fake.rows(schema.tasks)).toHaveLength(0);
  });
});
