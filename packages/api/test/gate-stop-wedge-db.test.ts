import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.GATE_STOP_WEDGE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/gate_stop_wedge_test'))
  throw new Error('Use a dedicated gate_stop_wedge_test database for the gate stop tests');

const USER = '00000000-0000-4000-8000-0000000000a2';
const BLIND_INDEX = 'gate-stop-wedge-test-user';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  queued: [] as { name: string; payload: unknown }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({
    add: async (name: string, payload: unknown) => {
      h.queued.push({ name, payload });
    },
  });
  return {
    getTaskQueue: queue,
    getRepoQueue: queue,
    getBundleQueue: queue,
    getCliExecQueue: queue,
    getUsagePollQueue: queue,
  };
});
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...shared,
    configService: {
      get: async () => null,
      getBoolean: async () => false,
      getFresh: async (key: string) =>
        key === shared.CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null,
      set: async () => undefined,
    },
  };
});

import { Hono } from 'hono';
import { TASK_JOB_NAMES } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

const GATE_SCHEMA = {
  title: 'Fix loop needs a decision',
  description: 'The checks still fail.',
  infoSections: [{ title: 'Latest diagnosis', body: 'tests failed', defaultOpen: true }],
  fields: [
    {
      type: 'radio',
      id: 'fixLoopAction',
      label: 'How would you like to proceed?',
      options: [
        { value: 'continue', label: 'Continue' },
        { value: 'accept', label: 'Accept' },
        { value: 'abort', label: 'Abort' },
      ],
      default: 'continue',
    },
    {
      type: 'textarea',
      id: 'fixLoopInstruction',
      label: 'Instructions',
      rows: 4,
      visibleWhen: { field: 'fixLoopAction', equals: 'continue' },
    },
  ],
  submitLabel: 'Apply decision',
};
const ANSWER = { fixLoopAction: 'continue', fixLoopInstruction: 'try the other branch' };
const STEP = '08b-test-management';

describe.skipIf(!url)('Stop over a fix-loop gate row on Postgres', () => {
  let db: Database;

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

  const seedTask = async (status: 'running' | 'waiting_user') => {
    const [row] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        type: 'workflow',
        title: 'gate-stop',
        status,
        currentStepId: STEP,
        currentRound: 1,
        orchestrationEpoch: 3,
      })
      .returning();
    return row!;
  };
  const seedRow = async (
    taskId: string,
    over: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: STEP,
        stepIndex: 8.5,
        runSeq: 5,
        round: 1,
        title: 'Test management',
        status: 'pending',
        formSchema: GATE_SCHEMA,
        formValues: ANSWER,
        waitingStartedAt: null,
        endedAt: null,
        detectOutput: {},
        output: { verdict: 'ISSUES_FOUND' },
        ...over,
      })
      .returning();
    return row!;
  };
  const rowOf = async (id: string) =>
    (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;
  const taskOf = async (id: string) =>
    (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) }))!;
  const stop = async (taskId: string) => {
    const res = await post(`/tasks/${taskId}/cancel-active-cli`);
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'gate-stop-wedge-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-real',
      role: 'user',
    });
  });

  beforeEach(async () => {
    h.queued = [];
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  it('fails a pending gate row that holds an answer, and the task', async () => {
    const task = await seedTask('running');
    const row = await seedRow(task.id);

    expect(await stop(task.id)).toEqual({
      status: 200,
      body: { ok: true, killed: 0, cancelled: 0, stopped: 1 },
    });

    const after = await rowOf(row.id);
    expect(after.status).toBe('failed');
    expect(after.errorMessage).toBe('Stopped by user');
    expect(after.endedAt).not.toBeNull();
    const t = await taskOf(task.id);
    expect(t.status).toBe('failed');
    expect(t.errorMessage).toBe('Stopped by user');
    expect(t.completedAt).not.toBeNull();
  });

  it('lets Retry reset the stopped gate row', async () => {
    const task = await seedTask('running');
    const row = await seedRow(task.id);
    await stop(task.id);

    const res = await post(`/tasks/${task.id}/action`, { action: 'retry' });

    expect(res.status).toBe(200);
    const after = await rowOf(row.id);
    expect(after.status).toBe('pending');
    expect(after.formSchema).toBeNull();
    expect(after.formValues).toBeNull();
    expect((await taskOf(task.id)).status).toBe('running');
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]!.name).toBe(TASK_JOB_NAMES.ADVANCE_STEP);
    expect(h.queued[0]!.payload).toMatchObject({ stepId: STEP, round: 1, epoch: 4 });
  });

  describe.each([
    {
      name: 'a pending row with no marker, answer or schema',
      task: 'running' as const,
      row: { formSchema: null, formValues: null },
    },
    {
      name: 'a re-offered never-answered gate',
      task: 'running' as const,
      row: { formValues: null },
    },
    {
      name: 'a waiting_form row of a waiting_user task that holds the answer',
      task: 'waiting_user' as const,
      row: { status: 'waiting_form' as const },
    },
  ])('Stop over $name', ({ task: taskStatus, row: over }) => {
    it('stops nothing and changes nothing', async () => {
      const task = await seedTask(taskStatus);
      const row = await seedRow(task.id, over);
      const before = await rowOf(row.id);

      expect(await stop(task.id)).toEqual({
        status: 200,
        body: { ok: true, killed: 0, cancelled: 0, stopped: 0 },
      });

      expect(await rowOf(row.id)).toEqual(before);
      expect((await taskOf(task.id)).status).toBe(taskStatus);
    });
  });

  it('Cancel ends the wedge', async () => {
    const task = await seedTask('running');
    const row = await seedRow(task.id);

    const res = await post(`/tasks/${task.id}/action`, { action: 'cancel' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'cancelled' });
    expect((await taskOf(task.id)).status).toBe('cancelled');
    expect((await rowOf(row.id)).status).toBe('failed');
    expect(h.queued.map((q) => q.name)).toEqual([TASK_JOB_NAMES.CANCEL]);
  });
});
