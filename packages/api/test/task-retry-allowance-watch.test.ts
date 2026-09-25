import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
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
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const PROVIDER = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

describe('retrying a task that failed on a provider outage', () => {
  it('clears the allowance watch the failure armed', async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      cliInvocations: schema.cliInvocations,
      taskEvents: schema.taskEvents,
    });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      status: 'failed',
      errorMessage: 'rate limited',
      awaitingAllowanceProviderId: PROVIDER,
      awaitingProviderReason: 'rate_limit',
      awaitingProviderSince: fake.now(),
      allowanceResetAt: fake.now(),
    });
    h.db = fake.db;

    const res = await app.request(`/${TASK}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });

    expect(res.status).toBe(200);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({
      status: 'queued',
      awaitingAllowanceProviderId: null,
      awaitingProviderReason: null,
      awaitingProviderSince: null,
      allowanceResetAt: null,
      allowanceReplenishedAt: null,
    });
  });
});
