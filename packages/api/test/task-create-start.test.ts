import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
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
import { TASK_JOB_NAMES } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const DRAFT = '00000000-0000-4000-8000-000000000001';

const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set('maintenanceState', 'normal');
  await next();
});
app.route('/', taskRoutes);
app.onError(errorHandler);

beforeEach(() => {
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
});

function setup() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  h.db = fake.db;
  const task = () => fake.rows(schema.tasks).find((r) => r.id !== DRAFT)!;
  return { fake, task };
}

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const create = () =>
  post('/', { type: 'workflow', title: 'a task', description: 'do it', repositoryId: REPO });
const starts = () =>
  h.add.mock.calls.filter(([name]) => name === TASK_JOB_NAMES.START).map(([, data]) => data);

describe('POST /tasks', () => {
  it('queues the task before it queues its START', async () => {
    const t = setup();
    h.add.mockImplementation(async () => {
      expect(t.task().status).toBe('queued');
    });
    const res = await create();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { id: string; status: string } };
    expect(body.task.status).toBe('queued');
    expect(starts()).toEqual([{ taskId: body.task.id, userId: USER }]);
  });

  // The stalled re-driver gives a `queued` task with no START one, and leaves `created` alone.
  it('answers 201 with the task queued when its START cannot be queued', async () => {
    const t = setup();
    h.add.mockRejectedValue(new Error('redis unavailable'));
    const res = await create();
    expect(res.status).toBe(201);
    expect(t.task().status).toBe('queued');
  });

  it('leaves the task created and queues nothing when a write before the start fails', async () => {
    const t = setup();
    t.fake.hooks.beforeInsert = (table) => {
      if (table === schema.taskEvents) throw new Error('db unavailable');
    };
    const res = await create();
    expect(res.status).toBe(500);
    expect(t.task().status).toBe('created');
    expect(h.add).not.toHaveBeenCalled();
  });
});

describe('the start action', () => {
  function draft() {
    const t = setup();
    t.fake.insert(schema.tasks, {
      id: DRAFT,
      userId: USER,
      type: 'plan_build',
      title: 'draft',
      repositoryId: REPO,
      status: 'created',
    });
    const row = () => t.fake.rows(schema.tasks).find((r) => r.id === DRAFT)!;
    return { ...t, row };
  }

  it('answers started with the task queued when its START cannot be queued', async () => {
    const t = draft();
    h.add.mockRejectedValue(new Error('redis unavailable'));
    const res = await post(`/${DRAFT}/action`, { action: 'start' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ started: true, status: 'queued' });
    expect(t.row().status).toBe('queued');
  });

  it('starts a draft once', async () => {
    draft();
    await post(`/${DRAFT}/action`, { action: 'start' });
    const again = await post(`/${DRAFT}/action`, { action: 'start' });
    expect(await again.json()).toMatchObject({ started: false, status: 'queued' });
    expect(starts()).toEqual([{ taskId: DRAFT, userId: USER }]);
  });
});
