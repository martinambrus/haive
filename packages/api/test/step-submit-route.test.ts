import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

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

it('refuses a PostgreSQL file parameter before persisting a tooling form', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  const stepId = '04-tooling-infrastructure';
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'running' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId,
    status: 'waiting_form',
    round: 0,
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  h.add.mockResolvedValueOnce(undefined);
  const before = structuredClone(fake.rows(schema.taskSteps));
  const res = await app.request(`/${TASK}/steps/${stepId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      values: {
        ragMode: 'external',
        ragConnectionString: `postgres://user:${randomBytes(12).toString('hex')}@db.invalid/store?sslkey=`,
      },
    }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    code: 'user_postgres_dsn_refused',
    error: expect.stringContaining('"sslkey"'),
  });
  expect(fake.rows(schema.taskSteps)).toEqual(before);
  expect(h.add).not.toHaveBeenCalled();
});

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

it('answers 200 with queued false when the queue never answers, the form write standing', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'waiting_user' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: STEP,
    status: 'waiting_form',
    round: 0,
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  h.add.mockImplementationOnce(() => new Promise(() => undefined));
  const res = await app.request(`/${TASK}/steps/${STEP}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { message: 'Follow up' } }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, queued: false });
  expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ formValues: { message: 'Follow up' } });
}, 10_000);

it('answers queued true when the queue accepts', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'waiting_user' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: STEP,
    status: 'waiting_form',
    round: 0,
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  h.add.mockResolvedValueOnce(undefined);
  const res = await app.request(`/${TASK}/steps/${STEP}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { message: 'Follow up' } }),
  });
  expect(await res.json()).toEqual({ ok: true, queued: true });
});

it('binds a gate-2 human decision to the authenticated owner and parked generation', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  const stepId = '09-gate-2-verify-approval';
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'waiting_user' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId,
    status: 'waiting_form',
    round: 2,
    rerunGeneration: 3,
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  h.add.mockResolvedValueOnce(undefined);
  const response = await app.request(`/${TASK}/steps/${stepId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { decision: 'approve' } }),
  });
  expect(response.status).toBe(200);
  expect(fake.rows(schema.taskEvents)).toEqual([
    expect.objectContaining({
      taskId: TASK,
      taskStepId: fake.rows(schema.taskSteps)[0]!.id,
      eventType: 'step.form_submitted',
      payload: expect.objectContaining({ userId: USER, generation: 3, decision: 'approve' }),
    }),
  ]);
  expect(fake.rows(schema.taskSteps)[0]).toMatchObject({
    waitingStartedAt: null,
    formValues: { decision: 'approve' },
  });
});
