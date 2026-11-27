import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { TASK_JOB_NAMES, type TaskJobPayload } from '@haive/shared';
import type { StepDefinition } from '@haive/shared/step';

const url = process.env.ADVANCE_EPOCHS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/advance_epochs_test'))
  throw new Error('Use a dedicated advance_epochs_test database');

const USER = vi.hoisted(() => '00000000-0000-4000-8000-000000000515');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  jobs: [] as TaskJobPayload[],
  detect: 0,
  apply: 0,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../worker/src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({
  getTaskQueue: () => ({ add: async (_name: string, data: TaskJobPayload) => h.jobs.push(data) }),
}));
vi.mock('../../worker/src/redis.js', () => ({
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<object>()),
  Queue: class {
    async add(_name: string, data: TaskJobPayload) {
      h.jobs.push(data);
    }
    async close() {}
  },
}));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (original) => {
  const shared = await original<typeof import('@haive/shared')>();
  return {
    ...shared,
    configService: {
      get: async () => null,
      getBoolean: async (key: string) => key === shared.CONFIG_KEYS.PR_WORKFLOW_ENABLED,
      getFresh: async () => 'normal',
    },
  };
});

import { Hono } from 'hono';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
// Runtime cross-package controls keep worker source outside the API tsc root.
const workerSource = (rel: string) => new URL(`../../worker/src/${rel}`, import.meta.url).pathname;
const { processTaskJob } = await import(workerSource('queues/task-queue.ts'));
const { autoResumeFailedStep } = await import(workerSource('queues/_step-reset.ts'));
const { runPrPollTick } = await import(workerSource('queues/pr-poll-queue.ts'));
const { stepRegistry } = await import(workerSource('step-engine/registry.ts'));

const TYPE = 'advance_epochs_test';
const STEP = 'advance-epochs-step';
const NEXT = 'advance-epochs-next';
const EPOCH = 3;
const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

describe.skipIf(!url)('advance producers and accepted answers on Postgres', () => {
  let db: Database;
  let repositoryId: string;
  const request = (path: string, body: unknown, method = 'POST') =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const readStep = (taskId: string) =>
    db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.taskId, taskId) });
  const readTask = (taskId: string) =>
    db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  const pickup = (data: TaskJobPayload) =>
    processTaskJob(
      {
        id: randomUUID(),
        name: TASK_JOB_NAMES.ADVANCE_STEP,
        data,
        timestamp: Date.now() - 1000,
        moveToDelayed: async () => undefined,
      } as Parameters<typeof processTaskJob>[0],
      'token',
    );
  const seed = async (
    stepId = STEP,
    status: 'waiting_user' | 'waiting_pr' | 'failed' = 'waiting_user',
  ) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        repositoryId,
        type: TYPE,
        title: 'advance epochs',
        status,
        autoContinue: true,
        currentStepId: stepId,
        currentRound: 1,
        orchestrationEpoch: EPOCH,
        runListSnapshot: [stepId, NEXT],
        prState: status === 'waiting_pr' ? 'merged' : null,
        prFinalizeMode: 'auto',
      })
      .returning();
    await db.insert(schema.taskSteps).values({
      taskId: task!.id,
      stepId,
      stepIndex: 1,
      runSeq: 0,
      round: 1,
      title: stepId,
      status: status === 'failed' ? 'failed' : 'waiting_form',
      formSchema: { title: 'decision', fields: [] },
      detectOutput: {},
      startedAt: new Date(Date.now() - 5000),
      waitingStartedAt: status === 'failed' ? null : new Date(Date.now() - 2000),
    });
    return task!.id;
  };
  const retry = async (taskId: string, stepId = STEP) => {
    const res = await request(`/tasks/${taskId}/steps/${stepId}/action`, { action: 'retry' });
    expect(res.status, await res.text()).toBe(200);
    expect((await readTask(taskId))!.orchestrationEpoch).toBe(EPOCH + 1);
  };
  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'test',
      emailBlindIndex: TYPE,
      passwordHash: 'test',
      role: 'user',
    });
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId: USER,
        name: TYPE,
        source: 'local_path',
        localPath: os.tmpdir(),
        storagePath: os.tmpdir(),
        status: 'ready',
      })
      .returning();
    repositoryId = repo!.id;
    await db
      .insert(schema.taskTypeDefinitions)
      .values({ slug: TYPE, displayName: TYPE, runListStrategy: 'static', source: 'test' });
    for (const id of [STEP, '13-pr-wait', NEXT])
      stepRegistry.override({
        metadata: {
          id,
          workflowType: TYPE,
          index: 1,
          title: id,
          description: 'test',
          requiresCli: false,
        },
        detect: async () => {
          h.detect++;
          return {};
        },
        form: () => ({ title: 'decision', fields: [] }),
        apply: async () => {
          h.apply++;
          return {};
        },
      } as StepDefinition);
  });
  beforeEach(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
    h.jobs.length = h.detect = h.apply = 0;
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
    await db.$client.end({ timeout: 5 });
  });

  it('1: a toggle advance queued before same-step Retry cannot claim its new pass', async () => {
    const taskId = await seed();
    expect((await request(`/tasks/${taskId}`, { autoContinue: true }, 'PATCH')).status).toBe(200);
    const old = h.jobs[0]!;
    await retry(taskId);
    const before = await readStep(taskId);
    await pickup(old);
    expect.soft(h.detect, 'stale toggle must not run detect').toBe(0);
    expect.soft(await readStep(taskId)).toEqual(before);
    await pickup(h.jobs.find((job) => job.epoch === EPOCH + 1)!);
    expect(h.detect).toBe(1);
    expect.soft((await readStep(taskId))!.status).toBe('waiting_form');
    expect(h.apply, 'the Retry must still wait for a new answer').toBe(0);
  });

  it('2: auto-resume invalidates an advance left from before the failure', async () => {
    const taskId = await seed(STEP, 'failed');
    const old = { taskId, userId: USER, stepId: STEP, round: 1, epoch: EPOCH };
    const resumed = await autoResumeFailedStep(db, {
      taskId,
      stepId: STEP,
      round: 1,
      providerId: null,
      via: 'test',
      watchSince: null,
    });
    expect(resumed).toBeTruthy();
    const before = await readStep(taskId);
    await pickup(old);
    expect.soft(h.apply, 'pre-failure advance must not execute the reopened pass').toBe(0);
    expect(await readStep(taskId)).toEqual(before);
    expect(resumed).toEqual({ epoch: EPOCH + 1 });
    await pickup({ ...old, epoch: EPOCH + 1 });
    expect(h.apply).toBe(1);
  });

  it('3: a conflicting second answer is refused and the first answer and single advance stand', async () => {
    const taskId = await seed();
    const path = `/tasks/${taskId}/steps/${STEP}/submit`;
    expect((await request(path, { values: { answer: 'first' } })).status).toBe(200);
    const before = await readStep(taskId);
    const res = await request(path, { values: { answer: 'replacement' } });
    expect.soft(res.status).toBe(409);
    expect.soft(await readStep(taskId)).toEqual(before);
    expect(h.jobs).toHaveLength(1);
  });

  it('3: an identical retry succeeds without another write, event or advance', async () => {
    const taskId = await seed();
    const path = `/tasks/${taskId}/steps/${STEP}/submit`;
    const body = { values: { answer: 'first', nested: { a: 1, b: 2 } } };
    expect((await request(path, body)).status).toBe(200);
    const before = await readStep(taskId);
    const res = await request(path, { values: { nested: { b: 2, a: 1 }, answer: 'first' } });
    expect.soft(res.status).toBe(200);
    expect.soft(await readStep(taskId)).toEqual(before);
    expect
      .soft(await db.query.taskEvents.findMany({ where: eq(schema.taskEvents.taskId, taskId) }))
      .toHaveLength(1);
    expect(h.jobs).toHaveLength(1);
  });

  it('4: an auto-finalize advance queued before same-step Retry cannot claim its new pass', async () => {
    const taskId = await seed('13-pr-wait', 'waiting_pr');
    await runPrPollTick(db);
    expect(h.jobs).toHaveLength(1);
    const old = h.jobs[0]!;
    await retry(taskId, '13-pr-wait');
    const before = await readStep(taskId);
    await pickup(old);
    expect.soft(h.detect, 'stale finalize must not run detect').toBe(0);
    expect.soft(await readStep(taskId)).toEqual(before);
    await pickup(h.jobs.find((job) => job.epoch === EPOCH + 1)!);
    expect(h.detect).toBe(1);
    expect.soft((await readStep(taskId))!.status).toBe('waiting_form');
    expect(h.apply, 'the Retry must still wait for a new answer').toBe(0);
  });
});
