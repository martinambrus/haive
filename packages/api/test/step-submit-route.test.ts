import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown, add: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const STEP = '02-plan-chat';
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.onError(errorHandler);
beforeEach(() => {
  h.add.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it.each(['running', 'done', 'failed'])(
  'returns a stable code when the step is %s rather than awaiting a form',
  async (status) => {
    const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
    fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'running' });
    fake.insert(schema.taskSteps, { taskId: TASK, stepId: STEP, status, round: 0 });
    h.db = fake.db;
    const before = structuredClone(fake.rows(schema.taskSteps));
    const res = await app.request(`/${TASK}/steps/${STEP}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { message: 'Follow up' } }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `No step awaiting form submission for id ${STEP}`,
      code: 'step_form_not_waiting',
    });
    expect(fake.rows(schema.taskSteps)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  },
);

it.each(['running', 'done', 'failed'])(
  'returns the same stable code when clarification step is %s rather than awaiting a form',
  async (status) => {
    const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
    fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'running' });
    fake.insert(schema.taskSteps, { taskId: TASK, stepId: STEP, status, round: 0 });
    h.db = fake.db;
    const before = structuredClone(fake.rows(schema.taskSteps));
    const res = await app.request(`/${TASK}/steps/${STEP}/clarify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'Keep both changes' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `No step awaiting clarification for id ${STEP}`,
      code: 'step_form_not_waiting',
    });
    expect(fake.rows(schema.taskSteps)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  },
);
