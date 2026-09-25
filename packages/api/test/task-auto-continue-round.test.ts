import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
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

const TASK = '00000000-0000-4000-8000-000000000001';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

describe('switching auto-continue on while a task waits on a form', () => {
  it('queues the advance for the round the task is on', async () => {
    const fake = createFakeDb({ tasks: schema.tasks, taskEvents: schema.taskEvents });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      status: 'waiting_user',
      autoContinue: false,
      currentStepId: '07-phase-2-implement',
      currentRound: 2,
    });
    h.db = fake.db;

    const res = await app.request(`/${TASK}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoContinue: true }),
    });

    expect(res.status).toBe(200);
    expect(h.add).toHaveBeenCalledWith(
      TASK_JOB_NAMES.ADVANCE_STEP,
      expect.objectContaining({ stepId: '07-phase-2-implement', round: 2 }),
      expect.anything(),
    );
  });
});
