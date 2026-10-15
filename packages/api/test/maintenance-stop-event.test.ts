import { describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000a2';
const TASK = '00000000-0000-4000-8000-000000000001';
const EARLIER = new Date('2026-10-15T09:00:00.000Z');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ADMIN);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/admin/maintenance', maintenanceRoutes);

function setup(task: Record<string, unknown> = {}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    cliInvocations: schema.cliInvocations,
    taskEvents: schema.taskEvents,
    auditEvents: schema.auditEvents,
  });
  fake.insert(schema.tasks, { id: TASK, userId: OWNER, status: 'running', ...task });
  const step = fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '07-phase-2-implement',
    round: 0,
    status: 'waiting_cli',
  });
  fake.insert(schema.cliInvocations, {
    taskId: TASK,
    taskStepId: step.id,
    mode: 'cli',
    prompt: 'implement',
  });
  h.db = fake.db;
  return fake;
}

const stop = () =>
  app.request(`/admin/maintenance/tasks/${TASK}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  });

describe('POST /admin/maintenance/tasks/:id/action stop', () => {
  it('records in its event and answers the instant it failed the task, the very stamp the task carries', async () => {
    const fake = setup();
    const res = await stop();
    expect(res.status).toBe(200);
    const { completedAt } = fake.rows(schema.tasks)[0]!;
    const failedAt = (completedAt as Date).toISOString();
    expect(await res.json()).toMatchObject({ ok: true, cancelled: 1, stopped: 1, failedAt });
    expect(fake.rows(schema.taskEvents).map((e) => [e.eventType, e.payload])).toEqual([
      [
        'task.stopped',
        {
          by: ADMIN,
          byAdmin: true,
          reason: 'maintenance',
          killed: 0,
          cancelled: 1,
          stopped: 1,
          failedAt,
        },
      ],
    ]);
  });

  it('records no instant for a task that had already failed', async () => {
    const fake = setup({ status: 'failed', completedAt: EARLIER });
    const res = await stop();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, cancelled: 1, stopped: 1, failedAt: null });
    expect(fake.rows(schema.taskEvents).map((e) => e.payload)).toMatchObject([{ failedAt: null }]);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'failed', completedAt: EARLIER });
  });
});
