import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
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
import { is, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const STEP = '12-worktree-cleanup';

const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set('maintenanceState', 'normal');
  await next();
});
app.route('/', taskRoutes);
app.onError(errorHandler);

const json = (path: string, method: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const actions: [string, () => Response | Promise<Response>][] = [
  ['a step Retry', () => json(`/${TASK}/steps/${STEP}/action`, 'POST', { action: 'retry' })],
  [
    'a step Retry with AI',
    () => json(`/${TASK}/steps/${STEP}/action`, 'POST', { action: 'retry_ai' }),
  ],
  ['a task Retry', () => json(`/${TASK}/action`, 'POST', { action: 'retry' })],
  [
    'a CLI switch on the step',
    () => json(`/${TASK}/steps/${STEP}/cli-provider`, 'PATCH', { cliProviderId: null }),
  ],
];

describe.each(actions)('%s on a step whose merge retries ran out', (_name, request) => {
  it('hands only the retry counter back', async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskEvents: schema.taskEvents,
      cliInvocations: schema.cliInvocations,
      taskStepAgentMinings: schema.taskStepAgentMinings,
      taskStepCliChoices: schema.taskStepCliChoices,
      taskDagPlans: schema.taskDagPlans,
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
    });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      type: 'onboarding',
      title: 't',
      status: 'failed',
      orchestrationEpoch: 3,
      currentStepId: STEP,
      currentRound: 0,
      completedAt: fake.now(),
    });
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: STEP,
      stepIndex: 1,
      runSeq: 1,
      round: 0,
      idleMs: 0,
      iterationCount: 0,
      status: 'failed',
      mergeResolveState: { conflictRetries: 4, merged: true },
    });
    h.db = fake.db;

    expect((await request()).status).toBe(200);

    const state = fake.rows(schema.taskSteps)[0]!.mergeResolveState;
    expect(is(state, SQL)).toBe(true);
    const { sql: text } = new PgDialect().sqlToQuery(state as unknown as SQL);
    expect(text).toContain(`jsonb_set(`);
    expect(text).toContain(`'{conflictRetries}', '0'::jsonb`);
    expect(text).toContain(`jsonb_typeof(`);
  });
});
