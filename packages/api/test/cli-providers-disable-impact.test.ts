import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { AppEnv } from '../src/context.js';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { resetStepFlagsCache } from '../src/lib/step-flags.js';

const h = vi.hoisted(() => ({ db: undefined as unknown, userId: '' }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', h.userId);
    await next();
  },
}));
const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);
const providerId = randomUUID();
let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  resetStepFlagsCache();
  h.userId = randomUUID();
  fake = createFakeDb({
    cliProviders: schema.cliProviders,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    stepCatalog: schema.stepCatalog,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
    taskStepCliChoices: schema.taskStepCliChoices,
    taskStepCliTouched: schema.taskStepCliTouched,
  });
  h.db = fake.db;
  fake.insert(schema.cliProviders, { id: providerId, userId: h.userId, enabled: true });
  for (const [stepId, dispatchesStepCli, providerSensitive] of [
    ['cli', true, false],
    ['sensitive', false, true],
    ['plain', false, false],
  ] as const)
    fake.insert(schema.stepCatalog, {
      stepId,
      title: stepId,
      workflowType: 'test',
      stepIndex: 0,
      dispatchesStepCli,
      providerSensitive,
      composable: false,
    });
});
function task(over: Record<string, unknown> = {}) {
  const id = randomUUID();
  fake.insert(schema.tasks, {
    id,
    userId: h.userId,
    type: 'test',
    status: 'running',
    deadAt: null,
    currentRound: 0,
    currentStepId: 'cli',
    cliProviderId: providerId,
    ignoreSavedStepClis: false,
    runListSnapshot: ['cli', 'sensitive', 'plain'],
    customSteps: null,
    ...over,
  });
  return id;
}
const read = () => app.request(`/${providerId}/disable-impact`);
describe('provider disable impact', () => {
  it('counts fresh CLI and provider-sensitive bindings, excluding continuations and other owners', async () => {
    task();
    const continued = task();
    fake.insert(schema.taskSteps, {
      taskId: continued,
      stepId: 'cli',
      round: 0,
      status: 'waiting_cli',
    });
    task({ status: 'completed' });
    task({ status: 'failed' });
    task({ userId: randomUUID() });
    task({ cliProviderId: null }); // an implicit default moves on disable; it never holds
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskCount: 2, stepCount: 3 });
    expect(fake.rows(schema.cliProviders)[0]?.enabled).toBe(true);
  });

  it('excludes dead and terminal tasks the worker cannot advance', async () => {
    task();
    for (const status of ['created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr'])
      task({ status, deadAt: new Date() });
    for (const status of ['completed', 'cancelled', 'failed']) task({ status });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskCount: 1, stepCount: 2 });
  });

  it('resolves task choices, cleared choices, saved preferences and the saved-choice lock', async () => {
    fake.insert(schema.userStepCliPreferences, {
      userId: h.userId,
      stepId: 'cli',
      cliProviderId: providerId,
      explicit: true,
    });
    task({ cliProviderId: null }); // saved cli only
    task({ cliProviderId: null, ignoreSavedStepClis: true });
    const cleared = task({ cliProviderId: null });
    fake.insert(schema.taskStepCliChoices, {
      taskId: cleared,
      stepId: 'cli',
      role: 'default',
      cliProviderId: null,
    });
    const picked = task({ cliProviderId: null, ignoreSavedStepClis: true });
    fake.insert(schema.taskStepCliChoices, {
      taskId: picked,
      stepId: 'sensitive',
      role: 'default',
      cliProviderId: providerId,
    });
    // A role-only choice is not checked by the pre-step provider hold.
    const roleOnly = task({ cliProviderId: null, ignoreSavedStepClis: true });
    fake.insert(schema.taskStepCliChoices, {
      taskId: roleOnly,
      stepId: 'cli',
      role: 'reviewer',
      cliProviderId: providerId,
    });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskCount: 2, stepCount: 2 });
  });

  it('hides impact for a provider owned by somebody else', async () => {
    h.userId = randomUUID();
    expect((await read()).status).toBe(404);
  });

  it('includes tasks waiting to start or resume', async () => {
    for (const status of ['created', 'queued', 'paused', 'waiting_user', 'waiting_pr'])
      task({ status });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskCount: 5, stepCount: 10 });
  });
});
