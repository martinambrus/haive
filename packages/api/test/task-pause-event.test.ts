import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
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
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const OWNER = '00000000-0000-4000-8000-0000000000a2';
const TASK = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/admin/maintenance', maintenanceRoutes);
app.onError(errorHandler);

const PAUSES = [
  {
    name: "the owner's pause",
    owner: USER,
    path: `/tasks/${TASK}/action`,
    recorded: { by: USER },
    resumed: { by: USER },
  },
  {
    name: "an administrator's pause",
    owner: OWNER,
    path: `/admin/maintenance/tasks/${TASK}/action`,
    recorded: { by: USER, byAdmin: true, reason: 'maintenance' },
    resumed: { by: USER, byAdmin: true },
  },
];

describe.each(PAUSES)('$name', ({ owner, path, recorded, resumed }) => {
  const setup = (over: Record<string, unknown> = {}) => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskEvents: schema.taskEvents,
      auditEvents: schema.auditEvents,
    });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: owner,
      type: 'workflow',
      title: 'a task',
      status: 'running',
      ...over,
    });
    h.db = fake.db;
    return fake;
  };
  const act = (action: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  const pause = () => act('pause');
  const resume = () => act('resume');

  it('sets pausedAt and records who paused', async () => {
    const fake = setup();

    expect((await pause()).status).toBe(200);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
    expect(fake.rows(schema.taskEvents)).toMatchObject([
      { eventType: 'task.paused', payload: recorded },
    ]);
  });

  it('answers an error and leaves the task unpaused when the event cannot be written', async () => {
    const fake = setup();
    fake.hooks.beforeInsert = (table) => {
      if (table === schema.taskEvents) throw new Error('task_events refused the insert');
    };

    expect((await pause()).status).toBe(500);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
    expect(fake.rows(schema.taskEvents)).toEqual([]);
  });

  it('clears pausedAt and records who resumed', async () => {
    const fake = setup({ pausedAt: new Date(0) });

    expect((await resume()).status).toBe(200);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
    expect(fake.rows(schema.taskEvents)).toMatchObject([
      { eventType: 'task.resumed', payload: resumed },
    ]);
  });

  it('answers an error and keeps the pause when the resumed event cannot be written', async () => {
    const pausedAt = new Date(0);
    const fake = setup({ pausedAt });
    fake.hooks.beforeInsert = (table) => {
      if (table === schema.taskEvents) throw new Error('task_events refused the insert');
    };

    expect((await resume()).status).toBe(500);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toEqual(pausedAt);
    expect(fake.rows(schema.taskEvents)).toEqual([]);
  });
});
