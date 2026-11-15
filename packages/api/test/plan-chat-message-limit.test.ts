import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: undefined as unknown, add: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));

import { Hono } from 'hono';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { planChatRequestSchema, normalizeStepFormValues } from '@haive/shared/schemas';
import { projectTaskStepOutputRoles } from '../src/lib/step-output-roles.js';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

describe('plan chat submit limit', () => {
  it.each(['', null, undefined, ' \n\t'])('accepts blank follow-up or pre-answer %j', (message) => {
    // Both the submit route and task creation normalize raw answers before saving them.
    const values = { message };
    expect(normalizeStepFormValues('01-plan-chat', values)).toEqual({
      success: true,
      data: values,
    });
  });

  it('accepts an opening or follow-up turn at the reserved limit', () => {
    const message = 'x'.repeat(20_000);
    expect(planChatRequestSchema.safeParse({ message }).success).toBe(true);
    expect(normalizeStepFormValues('01-plan-chat', { message }).success).toBe(true);
  });
  it('refuses oversized new turns on both submit surfaces with the limit stated', () => {
    const message = 'x'.repeat(20_001);
    expect(planChatRequestSchema.safeParse({ message }).success).toBe(false);
    const parsed = normalizeStepFormValues('01-plan-chat', { message });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.issues.join(' ')).toMatch(/20,000|20000/);
  });
});

it('accepts a blank plan-chat submit through the API and queues the saved answer', async () => {
  const userId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const taskId = 'aaaaaaaa-0000-4000-8000-000000000002';
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, { id: taskId, userId, status: 'waiting_user', type: 'plan_chat' });
  fake.insert(schema.taskSteps, {
    taskId,
    stepId: '01-plan-chat',
    round: 0,
    status: 'waiting_form',
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  h.add.mockReset().mockResolvedValue(undefined);
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/', stepRoutes);
  app.onError(errorHandler);
  const res = await app.request(`/${taskId}/steps/01-plan-chat/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { message: null } }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, queued: true });
  expect(fake.rows(schema.taskSteps)[0]?.formValues).toEqual({ message: null });
  expect(h.add.mock.calls[0]?.[1]).toMatchObject({ formValues: { message: null } });
});

it('displays a parked 06 upgrade without rewriting saved answers, recommendation or waiting time, and accepts omission', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  const userId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const taskId = 'aaaaaaaa-0000-4000-8000-000000000002';
  fake.insert(schema.tasks, { id: taskId, userId, type: 'workflow', status: 'waiting_user' });
  const waiting = fake.now();
  fake.insert(schema.taskSteps, {
    taskId,
    stepId: '06-run-config',
    round: 0,
    status: 'waiting_form',
    idleMs: 0,
    waitingStartedAt: waiting,
    formValues: { simplifyCode: false },
    iterations: [{ llmOutput: { rationale: 'keep' } }],
    formSchema: {
      title: 'Run',
      fields: [{ id: 'simplifyCode', type: 'checkbox', label: 'Simplify', default: true }],
    },
  });
  const original = structuredClone(fake.rows(schema.taskSteps)[0]!);
  const shown = await projectTaskStepOutputRoles(
    fake.db as unknown as Database,
    { type: 'workflow' },
    [original as typeof original & { stepId: string }],
  );
  expect(shown[0]!.formSchema).toMatchObject({
    fields: [
      { id: 'simplifyCode', default: true },
      {
        id: 'autoActOnInsights',
        visibleWhen: { field: 'autoActOnInsights', in: [] },
        default: false,
      },
    ],
  });
  expect(fake.rows(schema.taskSteps)[0]).toEqual(original);
  expect(
    await projectTaskStepOutputRoles(fake.db as unknown as Database, { type: 'workflow' }, shown),
  ).toEqual(shown);
  h.db = fake.db;
  h.add.mockReset().mockResolvedValue(undefined);
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/', stepRoutes);
  app.onError(errorHandler);
  const res = await app.request(`/${taskId}/steps/06-run-config/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { simplifyCode: false } }),
  });
  expect(res.status).toBe(200);
  expect(fake.rows(schema.taskSteps)[0]!.formValues).toEqual({
    simplifyCode: false,
    autoActOnInsights: false,
  });
  expect(fake.rows(schema.taskSteps)[0]!.iterations).toEqual(original.iterations);
});
