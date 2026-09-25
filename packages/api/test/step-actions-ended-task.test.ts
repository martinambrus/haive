import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
  kill: vi.fn(async (_taskId: string) => 0),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const STEP_ROW = '00000000-0000-4000-8000-0000000000c1';
const STEP = '11d-skill-sync';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.onError(errorHandler);

/** A task at `status` whose fan-out step failed with one agent left to re-run. */
function setup(status: string) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status,
    orchestrationEpoch: 3,
    currentStepId: STEP,
    currentRound: 0,
  });
  fake.insert(schema.taskSteps, {
    id: STEP_ROW,
    taskId: TASK,
    stepId: STEP,
    stepIndex: 1,
    runSeq: 1,
    round: 0,
    status: 'failed',
    errorMessage: 'boom',
    idleMs: 0,
  });
  fake.insert(schema.taskStepAgentMinings, {
    taskStepId: STEP_ROW,
    agentId: 'peer-reviewer',
    status: 'failed',
  });
  h.db = fake.db;
  return fake;
}

async function act(action: 'retry' | 'skip' | 'resume'): Promise<number> {
  const res = await app.request(`/${TASK}/steps/${STEP}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, round: 0 }),
  });
  return res.status;
}

describe('a step action on a task that has ended', () => {
  beforeEach(() => {
    h.add.mockClear();
    h.kill.mockClear();
  });

  it.each(['cancelled', 'completed'])(
    'refuses Retry, Skip and Resume on a %s task and changes nothing',
    async (status) => {
      for (const action of ['retry', 'skip', 'resume'] as const) {
        const fake = setup(status);
        expect(await act(action)).toBe(409);
        expect(fake.rows(schema.tasks)[0]).toMatchObject({ status, orchestrationEpoch: 3 });
        expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ status: 'failed' });
        expect(h.add).not.toHaveBeenCalled();
        expect(h.kill).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['retry', 'skip', 'resume'] as const)(
    'still moves a failed task back to the step on %s',
    async (action) => {
      const fake = setup('failed');
      expect(await act(action)).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({
        status: 'running',
        orchestrationEpoch: 4,
      });
      expect(h.add).toHaveBeenCalledTimes(1);
    },
  );
});
