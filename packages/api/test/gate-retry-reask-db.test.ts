import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.GATE_RETRY_REASK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/gate_retry_reask_test'))
  throw new Error('Use a dedicated gate_retry_reask_test database for the gate re-ask tests');

const USER = '00000000-0000-4000-8000-0000000000a1';
const BLIND_INDEX = 'gate-retry-reask-test-user';

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
import { settleActiveSteps } from '../src/lib/task-control.js';
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
const NON_GATE_SCHEMA = { title: 't', fields: [{ type: 'text', id: 'note', label: 'Note' }] };
const ANSWER = { fixLoopAction: 'continue', fixLoopInstruction: 'try the other branch' };
const STEP = '08b-test-management';
const STEP_SENSITIVE = '07_5-verify-files';

describe.skipIf(!url)('Retry over a fix-loop gate row on Postgres', () => {
  let db: Database;

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const patch = (path: string, body: unknown) =>
    app.request(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const seedTask = async (status: 'failed' | 'running') => {
    const [row] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        type: 'workflow',
        title: 'gate-reask',
        status,
        errorMessage: status === 'failed' ? 'boom' : null,
        completedAt: status === 'failed' ? new Date() : null,
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
        status: 'waiting_form',
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

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'gate-retry-reask-test@test.local',
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

  it.each([
    { fixLoopAction: 'continue', fixLoopInstruction: 'x' },
    { fixLoopAction: 'accept' },
    { fixLoopAction: 'abort' },
  ])('drops the saved answer %j so the gate asks again', async (answer) => {
    const task = await seedTask('failed');
    const row = await seedRow(task.id, { formValues: answer });

    const res = await post(`/tasks/${task.id}/action`, { action: 'retry' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'running' });
    const after = await rowOf(row.id);
    expect(after.status).toBe('pending');
    expect(after.formValues).toBeNull();
    expect(after.formSchema).toEqual(GATE_SCHEMA);
    expect(after.waitingStartedAt).toBeNull();
    const t = await taskOf(task.id);
    expect(t).toMatchObject({ status: 'running', orchestrationEpoch: 4, currentStepId: STEP });
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]!.name).toBe(TASK_JOB_NAMES.ADVANCE_STEP);
    expect(h.queued[0]!.payload).toEqual({
      taskId: task.id,
      userId: USER,
      stepId: STEP,
      round: 1,
      epoch: 4,
    });
  });

  it.each([
    { fixLoopAction: 'continue', fixLoopInstruction: 'x' },
    { fixLoopAction: 'accept' },
    { fixLoopAction: 'abort' },
  ])('marks the re-offered gate row %j to pause for a fresh answer', async (answer) => {
    const task = await seedTask('failed');
    const row = await seedRow(task.id, { formValues: answer });

    const res = await post(`/tasks/${task.id}/action`, { action: 'retry' });

    expect(res.status).toBe(200);
    expect((await rowOf(row.id)).pauseFormOnRetry).toBe(true);
  });

  it.each([{ note: 'keep me' }, { fixLoopAction: 3 }])(
    'keeps %j on a row that holds no gate answer',
    async (values) => {
      const task = await seedTask('failed');
      const row = await seedRow(task.id, {
        formSchema: NON_GATE_SCHEMA,
        formValues: values,
      });

      const res = await post(`/tasks/${task.id}/action`, { action: 'retry' });

      expect(res.status).toBe(200);
      const after = await rowOf(row.id);
      expect(after.status).toBe('pending');
      expect(after.formValues).toEqual(values);
      expect(after.pauseFormOnRetry).toBe(false);
    },
  );

  it('keeps a never-answered gate as it was', async () => {
    const task = await seedTask('failed');
    const row = await seedRow(task.id, {
      formValues: null,
      waitingStartedAt: new Date(Date.now() - 60_000),
    });

    const res = await post(`/tasks/${task.id}/action`, { action: 'retry' });

    expect(res.status).toBe(200);
    const after = await rowOf(row.id);
    expect(after.status).toBe('pending');
    expect(after.formValues).toBeNull();
    expect(after.formSchema).toEqual(GATE_SCHEMA);
    expect(after.waitingStartedAt).toBeNull();
    expect(after.pauseFormOnRetry).toBe(false);
  });

  it('settleActiveSteps drops a gate answer and keeps another form answer', async () => {
    const task = await seedTask('failed');
    const gate = await seedRow(task.id);
    const form = await seedRow(task.id, {
      stepId: '07-other',
      stepIndex: 7,
      runSeq: 4,
      formSchema: NON_GATE_SCHEMA,
      formValues: { note: 'keep me' },
    });

    await settleActiveSteps(db as never, task.id);

    const g = await rowOf(gate.id);
    const f = await rowOf(form.id);
    expect(g.status).toBe('pending');
    expect(g.formValues).toBeNull();
    expect(f.status).toBe('pending');
    expect(f.formValues).toEqual({ note: 'keep me' });
  });

  it('settleActiveSteps marks the gate row to pause and leaves another form alone', async () => {
    const task = await seedTask('failed');
    const gate = await seedRow(task.id);
    const form = await seedRow(task.id, {
      stepId: '07-other',
      stepIndex: 7,
      runSeq: 4,
      formSchema: NON_GATE_SCHEMA,
      formValues: { note: 'keep me' },
    });

    await settleActiveSteps(db as never, task.id);

    expect((await rowOf(gate.id)).pauseFormOnRetry).toBe(true);
    expect((await rowOf(form.id)).pauseFormOnRetry).toBe(false);
  });

  describe('PATCH /tasks/:id/steps/:stepId/cli-provider', () => {
    it('drops a gate answer when the provider change re-runs the step', async () => {
      const task = await seedTask('failed');
      const row = await seedRow(task.id, { iterationCount: 0 });

      const res = await patch(`/tasks/${task.id}/steps/${STEP}/cli-provider`, {
        cliProviderId: null,
      });

      expect(res.status).toBe(200);
      const after = await rowOf(row.id);
      expect(after.status).toBe('pending');
      expect(after.formSchema).toBeNull();
      expect(after.formValues).toBeNull();
    });

    it('keeps another form answer when the provider change re-runs the step', async () => {
      const task = await seedTask('failed');
      const row = await seedRow(task.id, {
        iterationCount: 0,
        formSchema: NON_GATE_SCHEMA,
        formValues: { note: 'keep me' },
      });

      const res = await patch(`/tasks/${task.id}/steps/${STEP}/cli-provider`, {
        cliProviderId: null,
      });

      expect(res.status).toBe(200);
      const after = await rowOf(row.id);
      expect(after.formValues).toEqual({ note: 'keep me' });
    });
  });

  describe('PATCH /tasks/:id/cli-provider (task-level switch)', () => {
    const sensitive = (taskId: string, runSeq: number, over = {}) =>
      seedRow(taskId, { stepId: STEP_SENSITIVE, stepIndex: 7.5, runSeq, round: runSeq, ...over });

    it('drops a gate answer from a waiting form and lists the reset step', async () => {
      const task = await seedTask('running');
      const row = await sensitive(task.id, 11);

      const res = await patch(`/tasks/${task.id}/cli-provider`, { cliProviderId: null });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { invalidatedSteps: string[] }).invalidatedSteps).toEqual([
        STEP_SENSITIVE,
      ]);
      const after = await rowOf(row.id);
      expect(after.status).toBe('pending');
      expect(after.formSchema).toBeNull();
      expect(after.formValues).toBeNull();
    });

    it('drops a gate answer left on an unparked pending row', async () => {
      const task = await seedTask('running');
      const row = await sensitive(task.id, 12, { status: 'pending', formSchema: null });

      const res = await patch(`/tasks/${task.id}/cli-provider`, { cliProviderId: null });

      expect(res.status).toBe(200);
      expect((await rowOf(row.id)).formValues).toBeNull();
    });

    it('keeps another form answer, and a non-string fixLoopAction', async () => {
      const task = await seedTask('running');
      const note = await sensitive(task.id, 13, {
        formSchema: NON_GATE_SCHEMA,
        formValues: { note: 'keep me' },
      });
      const numeric = await sensitive(task.id, 14, { formValues: { fixLoopAction: 3 } });

      const res = await patch(`/tasks/${task.id}/cli-provider`, { cliProviderId: null });

      expect(res.status).toBe(200);
      expect((await rowOf(note.id)).formValues).toEqual({ note: 'keep me' });
      expect((await rowOf(numeric.id)).formValues).toEqual({ fixLoopAction: 3 });
    });

    it('leaves a done row on a sensitive step untouched', async () => {
      const task = await seedTask('running');
      const row = await sensitive(task.id, 15, { status: 'done', endedAt: new Date() });

      const res = await patch(`/tasks/${task.id}/cli-provider`, { cliProviderId: null });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { invalidatedSteps: string[] }).invalidatedSteps).toEqual([]);
      const after = await rowOf(row.id);
      expect(after.status).toBe('done');
      expect(after.formValues).toEqual(ANSWER);
    });
  });
});
