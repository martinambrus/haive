import { eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.TASK_CUSTOM_STEPS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_custom_steps_test'))
  throw new Error('Use a dedicated task_custom_steps_test database for custom step tests');

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ACTOR_ID);
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => 'USD',
    getBoolean: async () => true,
  },
}));
vi.mock('@haive/shared/stats-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/stats-server')>()),
  resolveCostDisplay: async () => ({ currency: 'USD', rate: 1 }),
}));

import { Hono } from 'hono';
import { adminTaskTypeRoutes } from '../src/routes/task-types.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { definitionForCreate } from '../src/lib/task-type-definition.js';
import { resetStepFlagsCache } from '../src/lib/step-flags.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const ACTOR_ID = '00000000-0000-4000-8000-0000000000b1';
const USER_EMAIL_INDEX = 'task-custom-steps-test-user';
const TYPE = 'tcs-type';
const CUSTOM_ID = `custom.${TYPE}.review`;

const app = new Hono<AppEnv>();
app.route('/admin/task-types', adminTaskTypeRoutes);
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const promptStep = (template: string) => ({
  slug: 'review',
  title: 'Review step',
  template,
  capabilities: [] as string[],
  timeoutMs: 300_000,
});

describe.skipIf(!url)('prompt steps pinned on a task, on Postgres', () => {
  let db: Database;

  const clean = async () => {
    await db.delete(schema.tasks).where(like(schema.tasks.type, 'tcs-%'));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(like(schema.taskTypeDefinitions.slug, 'tcs-%'));
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.targetType, 'task_type'));
  };
  const customStepsText = async (taskId: string) =>
    (
      await db.execute<{ t: string | null }>(
        sql`select custom_steps::text as t from tasks where id = ${taskId}`,
      )
    )[0]!.t;

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await clean();
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.insert(schema.users).values({
      id: ACTOR_ID,
      emailEncrypted: 'task-custom-steps-test@test.local',
      emailBlindIndex: USER_EMAIL_INDEX,
      passwordHash: 'not-real',
      role: 'admin',
      status: 'active',
      tokenVersion: 0,
    });
  });

  afterAll(async () => {
    await clean();
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    resetStepFlagsCache();
    await clean();
    await db.delete(schema.stepCatalog);
    await db.insert(schema.stepCatalog).values({
      stepId: 'tcs-a',
      source: 'core',
      title: 'tcs-a',
      workflowType: 'workflow',
      dispatchesCli: false,
      allowSkip: false,
      providerSensitive: false,
      composable: true,
      entry: {
        stepId: 'tcs-a',
        label: 'tcs-a',
        group: 'build',
        dispatchesCli: false,
        requires: [],
        provides: [],
      },
    });
    const created = await send('POST', '/admin/task-types', {
      slug: TYPE,
      displayName: 'Type',
      stepIds: ['tcs-a', CUSTOM_ID],
      requiresRepository: true,
      promptSteps: { review: promptStep('First {{task.title}}') },
    });
    expect(created.status).toBe(201);
  });

  const insertTask = async () => {
    const def = await definitionForCreate(db, TYPE, { generic: true });
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: ACTOR_ID,
        type: TYPE,
        title: 'pinned',
        status: 'running',
        runListSnapshot: def.runListSnapshot,
        customSteps: def.customSteps,
      })
      .returning();
    return { def, task: task! };
  };

  it('copies the type prompt steps whose id is in the snapshot', async () => {
    const { def } = await insertTask();
    expect(def.runListSnapshot).toEqual(['00-model-health-workflow', 'tcs-a', CUSTOM_ID]);
    expect(def.customSteps).toEqual({ [CUSTOM_ID]: promptStep('First {{task.title}}') });
  });

  it('pins nothing for a type without prompt steps', async () => {
    await db.insert(schema.taskTypeDefinitions).values({
      slug: 'tcs-plain',
      displayName: 'Plain',
      runListStrategy: 'static',
      stepIds: ['tcs-a'],
      source: 'admin',
    });
    expect(await definitionForCreate(db, 'tcs-plain', { generic: true })).toMatchObject({
      customSteps: null,
    });
  });

  it('leaves a created task byte-equal when the type template is edited afterwards', async () => {
    const { task } = await insertTask();
    const before = await customStepsText(task.id);
    expect(before).toContain('First {{task.title}}');

    const edit = await send('PATCH', `/admin/task-types/${TYPE}`, {
      promptSteps: { review: promptStep('Second {{task.description}}') },
    });
    expect(edit.status).toBe(200);

    expect(await customStepsText(task.id)).toBe(before);
    const { def: later } = await insertTask();
    expect(later.customSteps?.[CUSTOM_ID]?.template).toBe('Second {{task.description}}');
  });

  it('leaves the pinned prompt bodies out of the task list', async () => {
    const { task } = await insertTask();
    const res = await send('GET', '/tasks?pageSize=100');
    expect(res.status).toBe(200);
    const { tasks } = (await res.json()) as { tasks: Record<string, unknown>[] };
    const listed = tasks.find((t) => t.id === task.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('customSteps');
  });

  it('gives the pinned custom step a CLI picker and a place in the upcoming list', async () => {
    const { task } = await insertTask();
    const res = await send('GET', `/tasks/${task.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      steps: { stepId: string; usesCli: boolean; canSkip: boolean }[];
      upcomingCliSteps: { stepId: string; title: string }[];
    };
    expect(body.upcomingCliSteps.map((s) => s.stepId)).toEqual([CUSTOM_ID]);
    expect(body.upcomingCliSteps[0]!.title).toBe('Review step');

    await db.insert(schema.taskSteps).values({
      taskId: task.id,
      stepId: CUSTOM_ID,
      stepIndex: 1,
      title: 'Review step',
      status: 'waiting_cli',
    });
    const after = (await (await send('GET', `/tasks/${task.id}`)).json()) as typeof body;
    expect(after.steps.find((s) => s.stepId === CUSTOM_ID)).toMatchObject({
      usesCli: true,
      canSkip: false,
    });
    expect(after.upcomingCliSteps).toEqual([]);
  });

  it('accepts a CLI choice for the custom step before it has a row, and still refuses an unknown id', async () => {
    const { task } = await insertTask();
    const choose = (stepId: string) =>
      send('PATCH', `/tasks/${task.id}/steps/${stepId}/cli-provider`, { cliProviderId: null });
    expect((await choose(CUSTOM_ID)).status).toBe(200);
    expect((await choose(`custom.${TYPE}.nope`)).status).toBe(404);
  });
});
