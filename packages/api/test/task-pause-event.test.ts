import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { findAdminPausedTaskIds } from '../src/routes/tasks/_helpers.js';
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
    admin: false,
    owner: USER,
    path: `/tasks/${TASK}/action`,
    recorded: { by: USER },
    resumed: { by: USER },
  },
  {
    name: "an administrator's pause",
    admin: true,
    owner: OWNER,
    path: `/admin/maintenance/tasks/${TASK}/action`,
    recorded: { by: USER, byAdmin: true, reason: 'maintenance' },
    resumed: { by: USER, byAdmin: true },
  },
];

describe.each(PAUSES)('$name', ({ admin, owner, path, recorded, resumed }) => {
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
  const act = (action: string, to = path) =>
    app.request(to, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  const pause = () => act('pause');
  const resume = () => act('resume');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets pausedAt and records who paused', async () => {
    const fake = setup();

    expect((await pause()).status).toBe(200);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
    expect(fake.rows(schema.taskEvents)).toMatchObject([
      { eventType: 'task.paused', payload: recorded },
    ]);
  });

  it('answers the stamp that stands and writes nothing for a task already paused', async () => {
    const pausedAt = new Date('2026-10-15T08:00:00.000Z');
    const fake = setup({ pausedAt });

    const res = await pause();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pausedAt: pausedAt.toISOString() });
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toEqual(pausedAt);
    expect(fake.rows(schema.taskEvents)).toEqual([]);
    expect(fake.rows(schema.auditEvents)).toEqual([]);
  });

  describe('when the other writer pauses between the check and the update', () => {
    const rival = PAUSES.find((p) => p.path !== path)!;
    const STANDING = '2026-10-15T08:00:05.000Z';
    const race = async () => {
      const fake = setup({ userId: USER });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-15T08:00:00.000Z'));
      fake.hooks.beforeUpdate = async (table) => {
        if (table !== schema.tasks) return;
        fake.hooks.beforeUpdate = null;
        vi.setSystemTime(new Date(STANDING));
        await act('pause', rival.path);
      };
      return { fake, res: await pause() };
    };

    it('answers with the stamp that stands', async () => {
      const { res } = await race();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, pausedAt: STANDING });
    });

    it('leaves that stamp on the task', async () => {
      const { fake } = await race();

      expect(fake.rows(schema.tasks)[0]?.pausedAt).toEqual(new Date(STANDING));
    });

    it('records no second event', async () => {
      const { fake } = await race();

      expect(fake.rows(schema.taskEvents)).toMatchObject([
        { eventType: 'task.paused', payload: rival.recorded },
      ]);
    });

    it('writes no second audit row', async () => {
      const { fake } = await race();

      expect(fake.rows(schema.auditEvents)).toHaveLength(rival.admin ? 1 : 0);
    });

    it('names the writer whose pause stands', async () => {
      const { fake } = await race();

      expect((await findAdminPausedTaskIds(fake.db as never, [TASK])).has(TASK)).toBe(rival.admin);
    });
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

  it("writes the audit row for an administrator's resume and none for the owner's", async () => {
    const fake = setup({ pausedAt: new Date(0) });

    expect((await resume()).status).toBe(200);
    expect(fake.rows(schema.auditEvents)).toHaveLength(admin ? 1 : 0);
  });

  describe('when the other writer resumes between the check and the update', () => {
    const rival = PAUSES.find((p) => p.path !== path)!;
    const race = async () => {
      const fake = setup({ userId: USER, pausedAt: new Date(0) });
      fake.hooks.beforeUpdate = async (table) => {
        if (table !== schema.tasks) return;
        fake.hooks.beforeUpdate = null;
        await act('resume', rival.path);
      };
      return { fake, res: await resume() };
    };

    it('answers as it does for a task already resumed', async () => {
      const { res } = await race();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, pausedAt: null });
    });

    it('leaves the task unpaused', async () => {
      const { fake } = await race();

      expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
    });

    it("records one event, the other writer's", async () => {
      const { fake } = await race();

      expect(fake.rows(schema.taskEvents)).toMatchObject([
        { eventType: 'task.resumed', payload: rival.resumed },
      ]);
    });

    it("writes the audit row once for an administrator's winning resume and never for a losing one", async () => {
      const { fake } = await race();

      expect(fake.rows(schema.auditEvents)).toHaveLength(rival.admin ? 1 : 0);
    });
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
