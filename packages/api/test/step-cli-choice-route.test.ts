import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: vi.fn(async () => 0) }));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const STEP_ROW = '00000000-0000-4000-8000-0000000000c1';
const CLI = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.onError(errorHandler);

/** A running task, an enabled CLI, and optionally a pending row for `withRow`. */
function setup(withRow?: string) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliProviders: schema.cliProviders,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, status: 'running', orchestrationEpoch: 1 });
  fake.insert(schema.cliProviders, { id: CLI, userId: USER, name: 'codex', enabled: true });
  if (withRow) {
    fake.insert(schema.taskSteps, {
      id: STEP_ROW,
      taskId: TASK,
      stepId: withRow,
      stepIndex: 1,
      runSeq: 1,
      round: 0,
      status: 'pending',
      iterationCount: 0,
      idleMs: 0,
      userActiveMs: 0,
      carriedWorkMs: 0,
      carriedIdleMs: 0,
      carriedUserActiveMs: 0,
    });
  }
  h.db = fake.db;
  return fake;
}

async function pick(stepId: string, body: Record<string, unknown>): Promise<number> {
  const res = await app.request(`/${TASK}/steps/${stepId}/cli-provider`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

describe("a step's CLI picked on a task", () => {
  beforeEach(() => h.add.mockClear());

  it("stays this task's, and leaves the saved preference alone", async () => {
    const fake = setup();
    expect(await pick('08c-code-review', { cliProviderId: CLI })).toBe(200);
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([
      { taskId: TASK, stepId: '08c-code-review', role: 'default', cliProviderId: CLI },
    ]);
    expect(fake.rows(schema.userStepCliPreferences)).toEqual([]);
  });

  it('is also saved for later tasks when the person asks', async () => {
    const fake = setup();
    expect(await pick('08c-code-review', { cliProviderId: CLI, remember: true })).toBe(200);
    expect(fake.rows(schema.taskStepCliChoices)).toHaveLength(1);
    expect(fake.rows(schema.userStepCliPreferences)).toMatchObject([
      { userId: USER, stepId: '08c-code-review', cliProviderId: CLI, explicit: true },
    ]);
  });

  it('keeps a role on a started step to this task too', async () => {
    const fake = setup('08a-browser-verify');
    expect(await pick('08a-browser-verify', { cliProviderId: CLI, role: 'fixer' })).toBe(200);
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([
      { stepId: '08a-browser-verify', role: 'fixer', cliProviderId: CLI },
    ]);
    expect(fake.rows(schema.userStepCliRolePreferences)).toEqual([]);
  });

  it("re-detects a pending row on the new pick without touching the user's saved CLI", async () => {
    const fake = setup('07b-phase-4-validate');
    expect(await pick('07b-phase-4-validate', { cliProviderId: CLI, round: 0 })).toBe(200);
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([{ cliProviderId: CLI }]);
    expect(fake.rows(schema.userStepCliPreferences)).toEqual([]);
    expect(fake.rows(schema.taskEvents)).toMatchObject([
      { eventType: 'step.cli_provider_preference_changed', payload: { remembered: false } },
    ]);
  });

  it('clears the slot for this task, and from the saved preferences only when asked', async () => {
    const fake = setup();
    fake.insert(schema.userStepCliPreferences, {
      userId: USER,
      stepId: '08c-code-review',
      cliProviderId: CLI,
      explicit: true,
    });
    expect(await pick('08c-code-review', { cliProviderId: null })).toBe(200);
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([{ cliProviderId: null }]);
    expect(fake.rows(schema.userStepCliPreferences)).toHaveLength(1);

    expect(await pick('08c-code-review', { cliProviderId: null, remember: true })).toBe(200);
    expect(fake.rows(schema.taskStepCliChoices)).toHaveLength(1);
    expect(fake.rows(schema.userStepCliPreferences)).toEqual([]);
  });

  it('refuses a disabled CLI before writing anything', async () => {
    const fake = setup();
    fake.patch(schema.cliProviders, CLI, { enabled: false });
    expect(await pick('08c-code-review', { cliProviderId: CLI, remember: true })).toBe(409);
    expect(fake.rows(schema.taskStepCliChoices)).toEqual([]);
    expect(fake.rows(schema.userStepCliPreferences)).toEqual([]);
  });
});
