import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: undefined as unknown, failure: true }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => ({ id: 'job' }) }) }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() =>
      h.failure
        ? child.emit(
            'error',
            Object.assign(new Error('Docker unavailable at /private/docker.sock secret=example'), {
              code: 'ENOENT',
            }),
          )
        : child.emit('close', 0),
    );
    return child;
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
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
app.onError(errorHandler);
app.route('/admin/maintenance', maintenanceRoutes);
app.route('/tasks', taskRoutes);
function setup() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    cliInvocations: schema.cliInvocations,
    taskEvents: schema.taskEvents,
    auditEvents: schema.auditEvents,
  });
  fake.insert(schema.tasks, {
    id: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-0000000000a1',
    status: 'running',
  });
  fake.insert(schema.taskSteps, {
    taskId: '00000000-0000-4000-8000-000000000001',
    stepId: 'work',
    status: 'running',
  });
  h.db = fake.db;
  return fake;
}
const post = (admin: boolean) =>
  app.request(
    admin
      ? '/admin/maintenance/tasks/00000000-0000-4000-8000-000000000001/action'
      : '/tasks/00000000-0000-4000-8000-000000000001/cancel-active-cli',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(admin ? { action: 'stop' } : {}),
    },
  );
beforeEach(() => {
  h.failure = true;
});
it.each([true, false])(
  '4 control: Docker spawn failure keeps committed Stop successful (admin=%s)',
  async (admin) => {
    const fake = setup();
    const response = await post(admin);
    expect(response.status).toBe(200);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'failed' });
    if (admin) {
      expect(
        fake.rows(schema.taskEvents).filter((r) => r.eventType === 'task.stopped'),
      ).toHaveLength(1);
      expect(
        fake.rows(schema.auditEvents).filter((r) => r.action === 'task.admin_stop'),
      ).toHaveLength(1);
    }
  },
);
it.each([true, false])('3: Stop exposes unconfirmed cleanup (admin=%s)', async (admin) => {
  const fake = setup();
  const response = await post(admin);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    killed: 0,
    killConfirmed: false,
    killError: 'sandbox_listing_failed',
  });
  if (admin) {
    expect(
      fake.rows(schema.taskEvents).find((r) => r.eventType === 'task.stopped')?.payload,
    ).toMatchObject({ killError: 'sandbox_listing_failed' });
    expect(
      fake.rows(schema.auditEvents).find((r) => r.action === 'task.admin_stop')?.metadata,
    ).toMatchObject({ killError: 'sandbox_listing_failed' });
  }
  expect(JSON.stringify(fake.rows(schema.taskEvents))).not.toContain('/private/docker.sock');
  expect(JSON.stringify(fake.rows(schema.auditEvents))).not.toContain('secret=example');
});
