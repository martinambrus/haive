import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  paused: true,
  beforeLift: () => {},
  add: vi.fn(async () => undefined),
  kill: vi.fn(async () => 0),
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
      getFresh: async () => String(h.paused),
      set: async (key: string, value: string) => {
        expect(key).toBe(shared.CONFIG_KEYS.GLOBAL_PAUSE);
        if (value === 'false') h.beforeLift();
        h.paused = value === 'true';
      },
    },
  };
});
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const OWNER = '00000000-0000-4000-8000-000000000002';
const TASK = '00000000-0000-4000-8000-000000000003';
const STAMP = new Date('2026-01-01');
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
const unsupported = [guarded, fixed, { version: 99 }];
const app = new Hono<AppEnv>();
app.route('/admin/maintenance', maintenanceRoutes);
app.route('/admin', adminRoutes);
app.onError(errorHandler);
const request = (path: string, body: unknown, method = 'POST') =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
function setup(contract: unknown) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    auditEvents: schema.auditEvents,
  });
  h.db = fake.db;
  fake.insert(schema.tasks, {
    id: TASK,
    userId: OWNER,
    type: 'test',
    status: 'running',
    executionContract: contract,
    pausedAt: STAMP,
    orchestrationEpoch: 3,
  });
  return fake;
}
const state = (fake: ReturnType<typeof setup>) =>
  structuredClone([
    fake.rows(schema.tasks),
    fake.rows(schema.taskEvents),
    fake.rows(schema.auditEvents),
  ]);
beforeEach(() => {
  h.paused = true;
  h.beforeLift = () => {};
  h.add.mockClear();
  h.kill.mockClear();
});
it.each(unsupported)(
  'admin Resume refuses an unsupported pin before any effect',
  async (contract) => {
    const fake = setup(contract);
    const before = state(fake);
    const res = await request(`/admin/maintenance/tasks/${TASK}/action`, { action: 'resume' });
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'invalid-execution-contract' });
    expect(state(fake)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
  },
);
it.each([null, empty])('admin Resume retains supported pin behavior', async (contract) => {
  const fake = setup(contract);
  const res = await request(`/admin/maintenance/tasks/${TASK}/action`, { action: 'resume' });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(fake.rows(schema.tasks)[0]).toMatchObject({
    pausedAt: null,
    executionContract: contract,
    orchestrationEpoch: 3,
  });
  expect(fake.rows(schema.taskEvents)).toMatchObject([{ eventType: 'task.resumed' }]);
  expect(fake.rows(schema.auditEvents)).toMatchObject([{ action: 'task.admin_resume' }]);
});
it.each(unsupported)(
  'global lift skips and reports an unsupported pin while ordinary work resumes',
  async (contract) => {
    const fake = setup(contract);
    const unheld = '00000000-0000-4000-8000-000000000004';
    fake.insert(schema.tasks, {
      id: unheld,
      userId: OWNER,
      type: 'test',
      status: 'queued',
      executionContract: contract,
    });
    for (const pin of [null, empty]) {
      fake.insert(schema.tasks, {
        userId: OWNER,
        type: 'test',
        status: 'running',
        executionContract: pin,
      });
    }
    for (const status of ['completed', 'cancelled'] as const) {
      fake.insert(schema.tasks, {
        userId: OWNER,
        type: 'test',
        status,
        executionContract: contract,
      });
    }
    fake.insert(schema.tasks, {
      userId: OWNER,
      type: 'test',
      status: 'running',
      executionContract: contract,
      deadAt: STAMP,
    });
    const before = structuredClone(fake.rows(schema.tasks));
    let heldBeforeLift = false;
    h.beforeLift = () => {
      // The durable per-task hold must already exist when the global switch is released.
      heldBeforeLift =
        fake.rows(schema.tasks).find((t) => t.id === unheld)?.pausedAt instanceof Date;
    };
    const res = await request('/admin/config/global-pause', { paused: false }, 'PUT');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(heldBeforeLift, 'unsupported task must be held before the global switch is lifted').toBe(
      true,
    );
    expect(await res.json()).toEqual({
      paused: false,
      skippedTasks: [
        { taskId: TASK, code: 'invalid-execution-contract', reason: expect.any(String) },
        { taskId: unheld, code: 'invalid-execution-contract', reason: expect.any(String) },
      ],
    });
    expect(h.paused).toBe(false);
    for (const row of before) {
      const after = fake.rows(schema.tasks).find((t) => t.id === row.id);
      if (row.id === unheld)
        expect(after).toMatchObject({
          ...row,
          pausedAt: expect.any(Date),
          updatedAt: expect.any(Date),
        });
      else expect(after).toEqual(row);
    }
    expect(h.add).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
  },
);
it('global pause engagement leaves tasks untouched', async () => {
  const fake = setup(guarded);
  const before = structuredClone(fake.rows(schema.tasks));
  const res = await request('/admin/config/global-pause', { paused: true }, 'PUT');
  expect(res.status).toBe(200);
  expect(fake.rows(schema.tasks)).toEqual(before);
});
