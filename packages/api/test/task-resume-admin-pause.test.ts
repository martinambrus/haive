import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: { id: '', role: 'user' as string },
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', h.actor.id);
    c.set('userRole', h.actor.role);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { TASK_JOB_NAMES, configService } from '@haive/shared';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const OWNER = { id: '00000000-0000-4000-8000-0000000000a2', role: 'user' };
const ADMIN = { id: '00000000-0000-4000-8000-0000000000a1', role: 'admin' };
const TASK = '00000000-0000-4000-8000-0000000000b1';
const DONE_ROW = '00000000-0000-4000-8000-0000000000c1';
const TARGET_ROW = '00000000-0000-4000-8000-0000000000c2';
const LATER_ROW = '00000000-0000-4000-8000-0000000000c3';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/admin/maintenance', maintenanceRoutes);
app.onError(errorHandler);
vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');

const TICK_MS = 1000;
let clock = 0;

const setup = (over: Record<string, unknown> = {}, taskOwner = OWNER) => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    auditEvents: schema.auditEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: taskOwner.id,
    type: 'workflow',
    title: 'a task',
    status: 'running',
    ...over,
  });
  h.db = fake.db;
  return fake;
};

const post = (path: string, action: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
const as = async (actor: { id: string; role: string }, path: string, action: string) => {
  clock += TICK_MS;
  vi.setSystemTime(new Date(1_800_000_000_000 + clock));
  h.actor = actor;
  return post(path, action);
};
const adminPause = () => as(ADMIN, `/admin/maintenance/tasks/${TASK}/action`, 'pause');
const adminResume = () => as(ADMIN, `/admin/maintenance/tasks/${TASK}/action`, 'resume');
const pauseBy = (actor: { id: string; role: string }) =>
  as(actor, `/tasks/${TASK}/action`, 'pause');
const resumeBy = (actor: { id: string; role: string }) =>
  as(actor, `/tasks/${TASK}/action`, 'resume');
const retryBy = (actor: { id: string; role: string }) =>
  as(actor, `/tasks/${TASK}/action`, 'retry');

beforeEach(() => {
  clock = 0;
  h.add.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('resume of a paused task', () => {
  it("R1 refuses the owner's resume of an administrator's pause with 409 and keeps the hold", async () => {
    const fake = setup();
    expect((await adminPause()).status).toBe(200);
    const stamp = fake.rows(schema.tasks)[0]?.pausedAt;
    expect(stamp).toBeInstanceOf(Date);

    const res = await resumeBy(OWNER);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Paused by an administrator',
      code: 'paused_by_admin',
    });
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toEqual(stamp);
    expect(fake.rows(schema.taskEvents).filter((e) => e.eventType === 'task.resumed')).toEqual([]);
  });

  it("R2 lets an administrator who owns the task resume an administrator's pause", async () => {
    const fake = setup({}, ADMIN);
    expect((await adminPause()).status).toBe(200);

    const res = await resumeBy(ADMIN);

    expect(res.status).toBe(200);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
    expect(fake.rows(schema.taskEvents).filter((e) => e.eventType === 'task.resumed')).toHaveLength(
      1,
    );
  });

  it("R3 lets the owner resume the owner's own pause", async () => {
    const fake = setup();
    expect((await pauseBy(OWNER)).status).toBe(200);

    const res = await resumeBy(OWNER);

    expect(res.status).toBe(200);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
  });

  it('R4 reads the newest pause: admin pause, admin resume, owner pause, owner resume succeeds', async () => {
    const fake = setup();
    expect((await adminPause()).status).toBe(200);
    expect((await adminResume()).status).toBe(200);
    expect((await pauseBy(OWNER)).status).toBe(200);

    const res = await resumeBy(OWNER);

    expect(res.status).toBe(200);
    expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
  });

  it("R5 refuses the owner's resume when an administrator pauses between the check and the update", async () => {
    const fake = setup();
    expect((await pauseBy(OWNER)).status).toBe(200);
    fake.hooks.beforeUpdate = async (table) => {
      if (table !== schema.tasks) return;
      fake.hooks.beforeUpdate = null;
      await (h.db as typeof fake.db)
        .update(schema.tasks)
        .set({ pausedAt: null })
        .where(eq(schema.tasks.id, TASK));
      await adminPause();
      h.actor = OWNER;
    };

    const res = await resumeBy(OWNER);
    const stamp = fake.rows(schema.tasks)[0]?.pausedAt;

    expect(res.status).toBe(409);
    expect(stamp).toBeInstanceOf(Date);
    expect(fake.rows(schema.taskEvents).filter((e) => e.eventType === 'task.resumed')).toEqual([]);
  });

  it('R8 still lets the owner cancel an administrator-paused task, and the pause goes with it', async () => {
    const fake = setup();
    expect((await adminPause()).status).toBe(200);

    const res = await as(OWNER, `/tasks/${TASK}/action`, 'cancel');

    expect(res.status).toBe(200);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'cancelled', pausedAt: null });
  });
});

type Holder = 'admin hold' | 'owner hold' | 'no hold';
const MATRIX: [string, typeof OWNER, Holder, boolean][] = [
  ['owner on an administrator hold', OWNER, 'admin hold', true],
  ['owner on an owner hold', OWNER, 'owner hold', false],
  ['owner on no hold', OWNER, 'no hold', false],
  ['administrator owner on an administrator hold', ADMIN, 'admin hold', false],
  ['administrator owner on an owner hold', ADMIN, 'owner hold', false],
];

const hold = async (kind: Holder, actor: typeof OWNER) => {
  if (kind === 'admin hold') await adminPause();
  if (kind === 'owner hold') await pauseBy(actor);
};

/** A task that failed on `step-b`, the second of three steps. */
const failedOnStep = (actor: typeof OWNER) => {
  const fake = setup(
    {
      status: 'failed',
      errorMessage: 'boom',
      orchestrationEpoch: 3,
      currentStepId: 'step-b',
      currentRound: 0,
      completedAt: new Date(0),
    },
    actor,
  );
  const row = (id: string, stepId: string, runSeq: number, values: Record<string, unknown>) =>
    fake.insert(schema.taskSteps, {
      id,
      taskId: TASK,
      stepId,
      stepIndex: runSeq,
      runSeq,
      round: 0,
      title: stepId,
      idleMs: 0,
      carriedWorkMs: 0,
      carriedIdleMs: 0,
      carriedUserActiveMs: 0,
      userActiveMs: 0,
      ...values,
    });
  row(DONE_ROW, 'step-a', 1, { status: 'done', output: { a: 1 } });
  row(TARGET_ROW, 'step-b', 2, { status: 'failed', errorMessage: 'kaboom' });
  row(LATER_ROW, 'step-c', 3, { status: 'pending' });
  return fake;
};

describe('Retry of a failed paused task', () => {
  describe.each(MATRIX)('START replay, %s', (_name, actor, kind, keeps) => {
    it(`${keeps ? 'keeps' : 'clears'} the hold, requeues and enqueues START`, async () => {
      const fake = setup({ status: 'failed', errorMessage: 'boom' }, actor);
      await hold(kind, actor);
      const stamp = fake.rows(schema.tasks)[0]?.pausedAt;
      expect(Boolean(stamp)).toBe(kind !== 'no hold');

      const res = await retryBy(actor);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'queued' });
      expect(fake.rows(schema.tasks)[0]?.status).toBe('queued');
      expect(fake.rows(schema.tasks)[0]?.pausedAt ?? null).toEqual(keeps ? stamp : null);
      expect(h.add.mock.calls.map(([name]) => name)).toEqual([TASK_JOB_NAMES.START]);
    });
  });

  describe.each(MATRIX)('step target, %s', (_name, actor, kind, keeps) => {
    it(`${keeps ? 'keeps' : 'clears'} the hold and still resets the step and advances`, async () => {
      const fake = failedOnStep(actor);
      await hold(kind, actor);
      const stamp = fake.rows(schema.tasks)[0]?.pausedAt;

      const res = await retryBy(actor);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'running' });
      expect(fake.rows(schema.tasks)[0]?.status).toBe('running');
      expect(fake.rows(schema.tasks)[0]?.pausedAt ?? null).toEqual(keeps ? stamp : null);
      expect(fake.rows(schema.taskSteps).find((r) => r.id === TARGET_ROW)).toMatchObject({
        status: 'pending',
        errorMessage: null,
      });
      expect(h.add.mock.calls.map(([name]) => name)).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
    });
  });

  describe.each([
    ['START replay', () => setup({ status: 'failed', errorMessage: 'boom' })],
    ['step target', () => failedOnStep(OWNER)],
  ])('%s that an administrator pause overtakes', (_shape, make) => {
    it('leaves the pause placed after the Retry read the task', async () => {
      const fake = make();
      fake.hooks.beforeUpdate = async (table) => {
        if (table !== schema.tasks) return;
        fake.hooks.beforeUpdate = null;
        await adminPause();
      };

      const res = await retryBy(OWNER);

      expect(res.status).toBe(200);
      expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
    });

    it('leaves the administrator pause that replaced the owner hold the Retry read', async () => {
      const fake = make();
      await pauseBy(OWNER);
      const read = fake.rows(schema.tasks)[0]?.pausedAt;
      fake.hooks.beforeUpdate = async (table) => {
        if (table !== schema.tasks) return;
        fake.hooks.beforeUpdate = null;
        await adminResume();
        await adminPause();
      };

      const res = await retryBy(OWNER);

      expect(res.status).toBe(200);
      const stamp = fake.rows(schema.tasks)[0]?.pausedAt;
      expect(stamp).toBeInstanceOf(Date);
      expect(stamp).not.toEqual(read);
    });
  });
});
