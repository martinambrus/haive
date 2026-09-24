import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

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
const STEP = '06c-dag-execute';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.onError(errorHandler);

/** A task at `status` whose merge step is parked on a clarification. */
function setup(status: string) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status,
    errorMessage: status === 'failed' ? 'boom' : null,
    completedAt: status === 'failed' ? fake.now() : null,
  });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: STEP,
    round: 0,
    status: 'waiting_form',
    idleMs: 0,
    waitingStartedAt: fake.now(),
  });
  h.db = fake.db;
  return fake;
}

async function clarify(): Promise<number> {
  const res = await app.request(`/${TASK}/steps/${STEP}/clarify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer: 'keep both changes' }),
  });
  return res.status;
}

describe('answering a clarification', () => {
  beforeEach(() => h.add.mockClear());

  it('reopens a task that failed while its form waited', async () => {
    const fake = setup('failed');
    expect(await clarify()).toBe(200);
    // The worker drops an advance on a failed task, and this one carries no answer of its own.
    expect(fake.rows(schema.tasks)[0]).toMatchObject({
      status: 'running',
      errorMessage: null,
      completedAt: null,
    });
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it('leaves a task that is waiting on the answer as it is', async () => {
    const fake = setup('waiting_user');
    expect(await clarify()).toBe(200);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'waiting_user' });
    expect(h.add).toHaveBeenCalledTimes(1);
  });
});
