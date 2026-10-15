import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
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
import { TASK_JOB_NAMES, configService } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { markQueuedForStart } from '../src/lib/task-start.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
import { seedStepCatalog } from './step-flags-fixture.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const STEP_ROW = '00000000-0000-4000-8000-0000000000c1';
const CLI = '00000000-0000-4000-8000-0000000000b1';
const STEP = '11d-skill-sync';
const UPCOMING_STEP = '08c-code-review';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);
vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');

type Rows = Record<string, unknown>;
/** The task row, optionally one step row on `STEP` and a failed fan-out agent on it. */
interface Fixture {
  task: Rows;
  step?: Rows;
  agents?: boolean;
}
interface Request {
  method: 'POST' | 'PATCH';
  path: string;
  body: unknown;
}
interface Case extends Fixture {
  name: string;
  request: Request;
  live: { status: number; queued: string[] };
}

const post = (path: string, body: unknown): Request => ({ method: 'POST', path, body });
const patch = (path: string, body: unknown): Request => ({ method: 'PATCH', path, body });
const send = ({ method, path, body }: Request) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const CASES: Case[] = [
  {
    name: 'action start',
    task: { type: 'plan_build', title: 'draft', status: 'created' },
    request: post(`/${TASK}/action`, { action: 'start' }),
    live: { status: 200, queued: [TASK_JOB_NAMES.START] },
  },
  {
    name: 'action retry of a task that failed on a step',
    task: { status: 'failed', errorMessage: 'boom', currentStepId: STEP },
    step: { status: 'failed', errorMessage: 'boom' },
    request: post(`/${TASK}/action`, { action: 'retry' }),
    live: { status: 200, queued: [TASK_JOB_NAMES.ADVANCE_STEP] },
  },
  {
    name: 'action retry of a task that failed before any step',
    task: { status: 'failed', errorMessage: 'boom' },
    request: post(`/${TASK}/action`, { action: 'retry' }),
    live: { status: 200, queued: [TASK_JOB_NAMES.START] },
  },
  {
    name: 'task cli-provider',
    task: { status: 'waiting_user', currentStepId: STEP },
    step: { status: 'waiting_form' },
    request: patch(`/${TASK}/cli-provider`, { cliProviderId: null }),
    live: { status: 200, queued: [] },
  },
  {
    name: 'step submit',
    task: { status: 'waiting_user', currentStepId: STEP },
    step: { status: 'waiting_form' },
    request: post(`/${TASK}/steps/${STEP}/submit`, { values: { answer: 'yes' } }),
    live: { status: 200, queued: [TASK_JOB_NAMES.ADVANCE_STEP] },
  },
  {
    name: 'step clarify',
    task: { status: 'waiting_user', currentStepId: STEP },
    step: { status: 'waiting_form' },
    request: post(`/${TASK}/steps/${STEP}/clarify`, { answer: 'keep both changes' }),
    live: { status: 200, queued: [TASK_JOB_NAMES.ADVANCE_STEP] },
  },
  {
    name: 'step retry',
    task: { status: 'failed', errorMessage: 'boom', currentStepId: STEP },
    step: { status: 'failed', errorMessage: 'boom' },
    request: post(`/${TASK}/steps/${STEP}/action`, { action: 'retry', round: 0 }),
    live: { status: 200, queued: [TASK_JOB_NAMES.ADVANCE_STEP] },
  },
  {
    name: 'step resume of a fan-out',
    task: { status: 'failed', errorMessage: 'boom', currentStepId: STEP },
    step: { status: 'failed', errorMessage: 'boom' },
    agents: true,
    request: post(`/${TASK}/steps/${STEP}/action`, { action: 'resume', round: 0 }),
    live: { status: 200, queued: [TASK_JOB_NAMES.ADVANCE_STEP] },
  },
  {
    name: 'step resume of a loop',
    task: { status: 'failed', errorMessage: 'boom', currentStepId: STEP },
    step: { status: 'failed', errorMessage: 'boom', iterationCount: 1 },
    request: post(`/${TASK}/steps/${STEP}/action`, { action: 'resume', round: 0 }),
    live: { status: 200, queued: [TASK_JOB_NAMES.ADVANCE_STEP] },
  },
  {
    name: 'step retry_ai',
    task: { status: 'failed', errorMessage: 'boom', currentStepId: STEP },
    step: { status: 'failed', errorMessage: 'boom' },
    request: post(`/${TASK}/steps/${STEP}/action`, { action: 'retry_ai', round: 0 }),
    live: { status: 200, queued: [TASK_JOB_NAMES.ADVANCE_STEP] },
  },
  {
    name: 'step skip',
    task: { status: 'failed', errorMessage: 'boom', currentStepId: STEP },
    step: { status: 'failed', errorMessage: 'boom' },
    request: post(`/${TASK}/steps/${STEP}/action`, { action: 'skip', round: 0 }),
    live: { status: 200, queued: [TASK_JOB_NAMES.ADVANCE_STEP] },
  },
  {
    name: 'step cli-provider on a started step',
    task: { status: 'failed', errorMessage: 'boom', currentStepId: STEP },
    step: { status: 'failed', errorMessage: 'boom' },
    request: patch(`/${TASK}/steps/${STEP}/cli-provider`, { cliProviderId: CLI, round: 0 }),
    live: { status: 200, queued: [TASK_JOB_NAMES.ADVANCE_STEP] },
  },
  {
    name: 'step cli-provider on a step the run has not reached',
    task: { status: 'running', currentStepId: STEP },
    request: patch(`/${TASK}/steps/${UPCOMING_STEP}/cli-provider`, { cliProviderId: CLI }),
    live: { status: 200, queued: [] },
  },
];

const WRITTEN = [
  schema.tasks,
  schema.taskSteps,
  schema.taskEvents,
  schema.cliInvocations,
  schema.taskStepAgentMinings,
  schema.taskStepCliChoices,
  schema.userStepCliPreferences,
  schema.userStepCliRolePreferences,
];

/** The fixture as a dead task (`dead_at` set, status kept) or as the same task alive. */
function setup(f: Fixture, dead: boolean) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    stepCatalog: schema.stepCatalog,
    cliProviders: schema.cliProviders,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
  });
  seedStepCatalog(fake);
  fake.insert(schema.cliProviders, { id: CLI, userId: USER, name: 'codex', enabled: true });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    orchestrationEpoch: 3,
    currentRound: 0,
    completedAt: f.task.status === 'failed' ? fake.now() : null,
    deadAt: dead ? fake.now() : null,
    deadReason: dead
      ? 'the run list names a step this install does not register: module.x.y'
      : null,
    ...f.task,
  });
  if (f.step) {
    fake.insert(schema.taskSteps, {
      id: STEP_ROW,
      taskId: TASK,
      stepId: STEP,
      stepIndex: 1,
      runSeq: 1,
      round: 0,
      iterationCount: 0,
      idleMs: 0,
      waitingStartedAt: f.step.status === 'waiting_form' ? fake.now() : null,
      ...f.step,
    });
  }
  if (f.agents) {
    fake.insert(schema.taskStepAgentMinings, {
      taskStepId: STEP_ROW,
      agentId: 'peer-reviewer',
      status: 'failed',
    });
  }
  h.db = fake.db;
  return { fake, snapshot: () => WRITTEN.map((table) => fake.rows(table)) };
}

const queuedNames = () => h.add.mock.calls.map(([name]) => name);

beforeEach(() => {
  h.add.mockClear();
  h.kill.mockClear();
});

describe.each(CASES)('$name', (c) => {
  it('is refused on a dead task, which keeps every row and queues and kills nothing', async () => {
    const t = setup(c, true);
    const before = t.snapshot();
    const res = await send(c.request);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.any(String), code: 'task_dead' });
    expect(t.snapshot()).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
  });

  it('goes through on a task that is not dead, writing and queueing as it always did', async () => {
    const t = setup(c, false);
    const before = t.snapshot();
    const res = await send(c.request);
    expect(res.status).toBe(c.live.status);
    expect(t.snapshot()).not.toEqual(before);
    expect(queuedNames()).toEqual(c.live.queued);
  });
});

describe('a form answered on a dead task', () => {
  const submit = CASES.find((c) => c.name === 'step submit')!;

  it('is not written to the step, and no ADVANCE is queued for the worker to drop', async () => {
    const t = setup(submit, true);
    await send(submit.request);
    expect.soft(t.fake.rows(schema.taskSteps)[0]?.formValues).toBeNull();
    expect.soft(queuedNames()).toEqual([]);
  });
});

describe('a dead task keeps what is not an advance', () => {
  const waiting: Fixture = {
    task: { status: 'waiting_user', currentStepId: STEP, autoContinue: false },
    step: { status: 'waiting_form' },
  };

  it('still cancels, and the cancelled task keeps its dead_at as history', async () => {
    const t = setup(waiting, true);
    const res = await send(post(`/${TASK}/action`, { action: 'cancel' }));
    expect(res.status).toBe(200);
    expect(t.fake.rows(schema.tasks)[0]).toMatchObject({ status: 'cancelled' });
    expect(t.fake.rows(schema.tasks)[0]?.deadAt).toBeInstanceOf(Date);
    expect(queuedNames()).toEqual([TASK_JOB_NAMES.CANCEL]);
  });

  it('still cancels through a step abort', async () => {
    const t = setup({ ...waiting, step: { status: 'failed' } }, true);
    const res = await send(post(`/${TASK}/steps/${STEP}/action`, { action: 'abort', round: 0 }));
    expect(res.status).toBe(200);
    expect(t.fake.rows(schema.tasks)[0]).toMatchObject({ status: 'cancelled' });
    expect(queuedNames()).toEqual([TASK_JOB_NAMES.CANCEL]);
  });

  it('still takes and drops the hold flag, which queues nothing', async () => {
    const t = setup(waiting, true);
    expect((await send(post(`/${TASK}/action`, { action: 'pause' }))).status).toBe(200);
    expect(t.fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
    expect((await send(post(`/${TASK}/action`, { action: 'resume' }))).status).toBe(200);
    expect(t.fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('still renames, and queues nothing', async () => {
    const t = setup(waiting, true);
    const res = await send(patch(`/${TASK}`, { title: 'renamed' }));
    expect(res.status).toBe(200);
    expect(t.fake.rows(schema.tasks)[0]).toMatchObject({ title: 'renamed' });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('writes auto-continue on a waiting_user task but queues no advance for it', async () => {
    const t = setup(waiting, true);
    const res = await send(patch(`/${TASK}`, { autoContinue: true }));
    expect(res.status).toBe(200);
    expect(t.fake.rows(schema.tasks)[0]).toMatchObject({ autoContinue: true });
    expect(t.fake.rows(schema.taskEvents)).toMatchObject([
      { eventType: 'task.auto_continue_changed', payload: { autoContinue: true } },
    ]);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('queues that advance when the same task is not dead (the control)', async () => {
    setup(waiting, false);
    const res = await send(patch(`/${TASK}`, { autoContinue: true }));
    expect(res.status).toBe(200);
    expect(queuedNames()).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
  });
});

describe('a cancelled or completed task that kept its dead_at is not dead', () => {
  const ended = (status: string): Fixture => ({
    task: { status, currentStepId: STEP, completedAt: new Date(0) },
    step: { status: 'failed' },
  });

  it.each(['cancelled', 'completed'])(
    'answers a step Retry on a %s task with the ended-task refusal, not task_dead',
    async (status) => {
      setup(ended(status), true);
      const res = await send(post(`/${TASK}/steps/${STEP}/action`, { action: 'retry', round: 0 }));
      expect(res.status).toBe(409);
      expect(await res.json()).not.toMatchObject({ code: 'task_dead' });
    },
  );

  it.each(['cancelled', 'completed'])(
    'answers a task cli-provider change on a %s task with its own refusal, not task_dead',
    async (status) => {
      setup(ended(status), true);
      const res = await send(patch(`/${TASK}/cli-provider`, { cliProviderId: null }));
      expect(res.status).toBe(409);
      expect(await res.json()).not.toMatchObject({ code: 'task_dead' });
    },
  );

  it.each(['cancelled', 'completed'])(
    'answers Start on a %s task as a start that did not happen, not task_dead',
    async (status) => {
      setup(ended(status), true);
      const res = await send(post(`/${TASK}/action`, { action: 'start' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ started: false, status });
    },
  );
});

describe('markQueuedForStart', () => {
  function created(dead: boolean) {
    const fake = createFakeDb({ tasks: schema.tasks });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      status: 'created',
      deadAt: dead ? fake.now() : null,
    });
    return fake;
  }

  it('leaves a dead created task as it is and answers nothing, so no START follows', async () => {
    const fake = created(true);
    const before = fake.rows(schema.tasks);
    expect(await markQueuedForStart(fake.db as never, TASK)).toBeUndefined();
    expect(fake.rows(schema.tasks)).toEqual(before);
  });

  it('queues a created task that is not dead (the control)', async () => {
    const fake = created(false);
    expect(await markQueuedForStart(fake.db as never, TASK)).toMatchObject({ status: 'queued' });
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'queued' });
  });
});
