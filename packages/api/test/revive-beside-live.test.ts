import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  kill: vi.fn(async (_taskId: string) => 0),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));
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

const REPO = '00000000-0000-4000-8000-0000000000c1';
const TASK = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const STEP = '11d-skill-sync';

const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set('maintenanceState', 'normal');
  await next();
});
app.route('/', taskRoutes);
app.onError(errorHandler);

beforeEach(() => {
  h.add.mockClear();
  h.kill.mockClear();
});

type Revival = {
  name: string;
  step: Record<string, unknown>;
  task?: Record<string, unknown>;
  mining?: boolean;
  worker?: boolean;
  request: () => Response | Promise<Response>;
};

const json = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const stepAction = (action: string) => () =>
  json(`/${TASK}/steps/${STEP}/action`, { action, round: 0 });

const revivals: Revival[] = [
  {
    name: 'a task Retry at the step it stopped on',
    step: { status: 'failed' },
    request: () => json(`/${TASK}/action`, { action: 'retry' }),
  },
  {
    name: 'a task Retry from START',
    step: { status: 'failed' },
    task: { currentStepId: null },
    request: () => json(`/${TASK}/action`, { action: 'retry' }),
  },
  { name: 'a step Retry', step: { status: 'failed' }, request: stepAction('retry') },
  { name: 'a step Retry with AI', step: { status: 'failed' }, request: stepAction('retry_ai') },
  { name: 'a step Skip', step: { status: 'failed' }, request: stepAction('skip') },
  {
    name: 'a loop step Resume',
    step: { status: 'failed', iterationCount: 1 },
    request: stepAction('resume'),
  },
  {
    name: 'a fan-out step Resume',
    step: { status: 'failed' },
    mining: true,
    request: stepAction('resume'),
  },
  {
    name: 'an answer to a clarification',
    step: { status: 'waiting_form', waitingStartedAt: new Date() },
    request: () => json(`/${TASK}/steps/${STEP}/clarify`, { answer: 'keep both' }),
  },
  {
    name: 'an answer to the parked form',
    worker: true,
    step: { status: 'waiting_form', waitingStartedAt: new Date() },
    request: () => json(`/${TASK}/steps/${STEP}/submit`, { values: {} }),
  },
];

/** A failed `type` task on a step, and beside it a task of `otherType` at `otherStatus`. */
function setup(
  type: string,
  revival: Revival,
  other?: { type: string; status: string },
  repo: Record<string, unknown> = {},
) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: 'ready',
    renderContext: null,
    ...repo,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type,
    title: type,
    status: 'failed',
    errorMessage: 'boom',
    orchestrationEpoch: 3,
    currentStepId: STEP,
    currentRound: 0,
    completedAt: fake.now(),
    ...revival.task,
  });
  if (other) {
    fake.insert(schema.tasks, {
      id: OTHER,
      userId: USER,
      repositoryId: REPO,
      type: other.type,
      title: other.type,
      status: other.status,
    });
  }
  const stepRow = fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: STEP,
    stepIndex: 1,
    runSeq: 1,
    round: 0,
    idleMs: 0,
    ...revival.step,
  });
  if (revival.mining) {
    fake.insert(schema.taskStepAgentMinings, {
      taskStepId: (stepRow as { id: string }).id,
      agentId: 'peer-reviewer',
      status: 'failed',
    });
  }
  h.db = fake.db;
  const task = () => fake.rows(schema.tasks).find((r) => r.id === TASK)!;
  return { fake, task };
}

describe.each([
  ['an onboarding', 'onboarding', 'an upgrade', 'onboarding_upgrade', 'upgrade or rollback'],
  ['an upgrade', 'onboarding_upgrade', 'an onboarding', 'onboarding', 'Onboarding is still'],
])('reviving a failed %s', (_n, type, _o, otherType, refusal) => {
  describe.each(revivals)('by $name', (revival) => {
    it.each(['created', 'queued', 'running', 'waiting_user'])(
      `answers 409 and stays failed beside a live ${otherType} task (%s)`,
      async (status) => {
        const t = setup(type, revival, { type: otherType, status });
        const res = await revival.request();
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ error: expect.stringContaining(refusal) });
        expect(t.task()).toMatchObject({ status: 'failed', orchestrationEpoch: 3 });
        expect(h.add).not.toHaveBeenCalled();
      },
    );

    it('answers 409 while the reset holds the root claim', async () => {
      const t = setup(type, revival, undefined, {
        rootClaimedAt: new Date(),
        rootClaimKind: 'reset',
        rootClaimOwner: 'x',
      });
      const res = await revival.request();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('being reset') });
      expect(t.task()).toMatchObject({ status: 'failed', orchestrationEpoch: 3 });
      expect(h.add).not.toHaveBeenCalled();
    });

    it('still revives with no live task beside it, or only a finished one', async () => {
      for (const other of [undefined, { type: otherType, status: 'completed' }]) {
        h.add.mockClear();
        const t = setup(type, revival, other);
        expect((await revival.request()).status).toBe(200);
        if (!revival.worker) expect(t.task().status).not.toBe('failed');
        expect(h.add).toHaveBeenCalledTimes(1);
      }
    });
  });
});

describe('reviving a task of another type', () => {
  it('is not held by a live onboarding or upgrade', async () => {
    const t = setup('workflow', revivals[2]!, { type: 'onboarding_upgrade', status: 'running' });
    expect((await revivals[2]!.request()).status).toBe(200);
    expect(t.task().status).toBe('running');
  });
});

describe('creating an onboarding', () => {
  it.each(['the queued mark', 'the created event'])(
    'leaves no task row when %s fails',
    async (failing) => {
      const t = setup('onboarding', revivals[0]!);
      t.fake.hooks.beforeUpdate = async (table) => {
        if (failing === 'the queued mark' && table === schema.tasks) throw new Error('boom');
      };
      t.fake.hooks.beforeInsert = async (table) => {
        if (failing === 'the created event' && table === schema.taskEvents) throw new Error('boom');
      };
      const res = await json('/', { type: 'onboarding', title: 'Onboarding', repositoryId: REPO });
      expect(res.status).toBe(500);
      expect(t.fake.rows(schema.tasks).map((r) => r.id)).toEqual([TASK]);
    },
  );
});
