import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000a2';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const STAMP = new Date('2026-10-15T08:00:00.000Z');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: { id: '00000000-0000-4000-8000-0000000000a1', role: 'admin' },
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', h.actor.id);
    c.set('userRole', h.actor.role);
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

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/admin/maintenance', maintenanceRoutes);
app.onError(errorHandler);

const post = (path: string, action: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
const adminAct = (action: string) => {
  h.actor = { id: ADMIN, role: 'admin' };
  return post(`/admin/maintenance/tasks/${TASK}/action`, action);
};
const ownerAct = (action: string) => {
  h.actor = { id: OWNER, role: 'user' };
  return post(`/tasks/${TASK}/action`, action);
};

const setup = (over: Record<string, unknown> = {}) => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    auditEvents: schema.auditEvents,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: OWNER,
    type: 'workflow',
    title: 'a task',
    status: 'running',
    ...over,
  });
  h.db = fake.db;
  return fake;
};
const ownerPaused = async () => {
  const fake = setup();
  expect((await ownerAct('pause')).status).toBe(200);
  return { fake, stamp: fake.rows(schema.tasks)[0]!.pausedAt as Date };
};

describe("an administrator's pause of a task its owner paused", () => {
  beforeEach(() => {
    h.actor = { id: ADMIN, role: 'admin' };
  });

  it('keeps paused_at and answers the standing stamp', async () => {
    const { fake, stamp } = await ownerPaused();

    const res = await adminAct('pause');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pausedAt: stamp.toISOString() });
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toEqual(stamp);
  });

  it('writes one administrator pause event and one audit row marked tookOver', async () => {
    const { fake, stamp } = await ownerPaused();

    await adminAct('pause');

    const paused = fake.rows(schema.taskEvents).filter((e) => e.eventType === 'task.paused');
    expect(paused).toHaveLength(2);
    expect(paused[1]?.payload).toEqual({ by: ADMIN, byAdmin: true, reason: 'maintenance' });
    expect(fake.rows(schema.auditEvents)).toMatchObject([
      {
        action: 'task.admin_pause',
        targetId: TASK,
        metadata: { ownerUserId: OWNER, pausedAt: stamp.toISOString(), tookOver: true },
      },
    ]);
  });

  it('refuses the owner Resume with 409 and lets an administrator lift it', async () => {
    const { fake } = await ownerPaused();
    await adminAct('pause');

    const refused = await ownerAct('resume');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'paused_by_admin' });
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
    expect((await adminAct('resume')).status).toBe(200);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
  });

  it('takes over a pause that has no event at all', async () => {
    const fake = setup({ pausedAt: STAMP });

    const res = await adminAct('pause');

    expect(await res.json()).toEqual({ ok: true, pausedAt: STAMP.toISOString() });
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toEqual(STAMP);
    expect(fake.rows(schema.taskEvents)).toMatchObject([
      { eventType: 'task.paused', payload: { by: ADMIN, byAdmin: true } },
    ]);
    expect(fake.rows(schema.auditEvents)).toHaveLength(1);
    expect((await ownerAct('resume')).status).toBe(409);
  });

  it('writes nothing for a second administrator pause', async () => {
    const { fake } = await ownerPaused();
    await adminAct('pause');
    const events = fake.rows(schema.taskEvents).length;

    const res = await adminAct('pause');

    expect(res.status).toBe(200);
    expect(fake.rows(schema.taskEvents)).toHaveLength(events);
    expect(fake.rows(schema.auditEvents)).toHaveLength(1);
  });

  it('writes nothing for a pause an administrator already holds', async () => {
    const fake = setup();
    await adminAct('pause');
    const stamp = fake.rows(schema.tasks)[0]?.pausedAt;

    await adminAct('pause');

    expect(fake.rows(schema.tasks)[0]?.pausedAt).toEqual(stamp);
    expect(fake.rows(schema.taskEvents)).toHaveLength(1);
    expect(fake.rows(schema.auditEvents)).toHaveLength(1);
  });

  it.each([
    ['audit row', schema.auditEvents],
    ['event', schema.taskEvents],
  ])('answers 500 and changes nothing when the %s cannot be written', async (_name, table) => {
    const { fake, stamp } = await ownerPaused();
    const events = fake.rows(schema.taskEvents).length;
    fake.hooks.beforeInsert = (t) => {
      if (t === table) throw new Error('refused the insert');
    };

    const res = await adminAct('pause');

    expect(res.status).toBe(500);
    expect(fake.rows(schema.taskEvents)).toHaveLength(events);
    expect(fake.rows(schema.auditEvents)).toEqual([]);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toEqual(stamp);
    fake.hooks.beforeInsert = null;
    expect((await ownerAct('resume')).status).toBe(200);
  });

  it('still pauses an unpaused task outright', async () => {
    const fake = setup();

    const res = await adminAct('pause');

    expect(res.status).toBe(200);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
    expect(fake.rows(schema.taskEvents)).toHaveLength(1);
    expect(fake.rows(schema.auditEvents)).toMatchObject([
      { metadata: { ownerUserId: OWNER, pausedAt: expect.any(String) } },
    ]);
    expect(fake.rows(schema.auditEvents)[0]?.metadata).not.toHaveProperty('tookOver');
  });
});
