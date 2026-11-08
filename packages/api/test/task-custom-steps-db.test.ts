import { eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import {
  customToolSchema,
  describeInvalidTools,
  parsePinnedCustomSteps,
  shownToolName,
  validateCustomTools,
} from '@haive/shared/modularity';

const url = process.env.TASK_CUSTOM_STEPS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_custom_steps_test'))
  throw new Error('Use a dedicated task_custom_steps_test database for custom step tests');

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  switchOn: true,
  switchOutage: false,
  switchReads: 0,
  adds: [] as { name: string; data: unknown }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({
  getTaskQueue: () => ({
    add: async (name: string, data: unknown) => {
      h.adds.push({ name, data });
    },
  }),
}));
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
    getFresh: async () => 'normal',
    getBoolean: async (key: string) => {
      if (key !== CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED) return true;
      h.switchReads += 1;
      if (h.switchOutage) throw new ConfigUnavailableError('get');
      return h.switchOn;
    },
  },
}));
vi.mock('@haive/shared/stats-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/stats-server')>()),
  resolveCostDisplay: async () => ({ currency: 'USD', rate: 1 }),
}));

import { Hono } from 'hono';
import { CONFIG_KEYS, ConfigUnavailableError, TASK_JOB_NAMES } from '@haive/shared';
import { markQueuedForStart } from '../src/lib/task-start.js';
import { HttpError } from '../src/context.js';
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
    await db.delete(schema.repositories).where(like(schema.repositories.name, 'tcs-gate-%'));
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
    h.switchOn = true;
    h.switchOutage = false;
    h.switchReads = 0;
    h.adds = [];
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

  const insertTask = async (type: string = TYPE, status: string = 'running') => {
    const def = await definitionForCreate(db, type, { generic: true });
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: ACTOR_ID,
        type,
        title: 'pinned',
        status: status as 'running',
        runListSnapshot: def.runListSnapshot,
        customSteps: def.customSteps,
      })
      .returning();
    return { def, task: task! };
  };

  it('copies the type prompt steps whose id is in the snapshot', async () => {
    const { def } = await insertTask();
    expect(def.runListSnapshot).toEqual(['00-model-health-workflow', 'tcs-a', CUSTOM_ID]);
    expect(def.customSteps).toEqual({
      [CUSTOM_ID]: { ...promptStep('First {{task.title}}'), tools: [] },
    });
  });

  it('puts the model-health step first for a prompt step even before the catalog is synced', async () => {
    await db.delete(schema.stepCatalog);
    const { def } = await insertTask();
    expect(def.runListSnapshot?.[0]).toBe('00-model-health-workflow');
    expect(def.runListSnapshot).toContain(CUSTOM_ID);
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
    expect(later.customSteps?.[CUSTOM_ID]).toMatchObject({
      template: 'Second {{task.description}}',
    });
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
    expect((body as unknown as { task: Record<string, unknown> }).task).not.toHaveProperty(
      'customSteps',
    );
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

  describe('a pinned step that writes files', () => {
    const WRITER_TYPE = 'tcs-writer';
    const WORKTREE = '01-worktree-setup';

    const setUp = async (capabilities: string[]) => {
      await db.delete(schema.stepCatalog);
      await db.insert(schema.stepCatalog).values({
        stepId: WORKTREE,
        source: 'core',
        title: 'Worktree setup',
        workflowType: 'workflow',
        dispatchesCli: false,
        allowSkip: false,
        providerSensitive: false,
        composable: true,
        stepIndex: 0,
        entry: {
          stepId: WORKTREE,
          label: 'Worktree setup',
          group: 'setup',
          dispatchesCli: false,
          requires: [{ needs: 'repository', reason: 'Cuts the worktree from the repository.' }],
          provides: ['worktree', 'clean-tree'],
        },
      });
      resetStepFlagsCache();
      const created = await send('POST', '/admin/task-types', {
        slug: WRITER_TYPE,
        displayName: 'Writer',
        stepIds: [WORKTREE, `custom.${WRITER_TYPE}.review`],
        requiresRepository: true,
        promptSteps: { review: { ...promptStep('Write {{task.title}}'), capabilities } },
      });
      expect(created.status).toBe(201);
      const { task } = await insertTask(WRITER_TYPE);
      await db.insert(schema.taskSteps).values({
        taskId: task.id,
        stepId: WORKTREE,
        stepIndex: 0,
        title: 'Worktree setup',
        status: 'waiting_form',
      });
      return task;
    };
    const skip = (taskId: string) =>
      send('POST', `/tasks/${taskId}/steps/${WORKTREE}/action`, { action: 'skip' });

    it('keeps the worktree step unskippable in the task view and refuses its skip action', async () => {
      const task = await setUp(['file_write']);
      const view = (await (await send('GET', `/tasks/${task.id}`)).json()) as {
        steps: { stepId: string; canSkip: boolean }[];
      };
      expect(view.steps.find((s) => s.stepId === WORKTREE)).toMatchObject({ canSkip: false });
      const stepsOnly = (await (await send('GET', `/tasks/${task.id}/steps`)).json()) as {
        steps: { stepId: string; canSkip: boolean }[];
      };
      expect(stepsOnly.steps.find((s) => s.stepId === WORKTREE)).toMatchObject({ canSkip: false });
      const res = await skip(task.id);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain('This step cannot be skipped');
    });

    it('lets the worktree step go when the pinned step only reads', async () => {
      const task = await setUp(['tool_use']);
      const view = (await (await send('GET', `/tasks/${task.id}`)).json()) as {
        steps: { stepId: string; canSkip: boolean }[];
      };
      expect(view.steps.find((s) => s.stepId === WORKTREE)).toMatchObject({ canSkip: true });
    });
  });

  describe('a stored prompt step with a tool that no longer parses', () => {
    const BAD_TYPE = 'tcs-bad-tool';
    const BAD_ID = `custom.${BAD_TYPE}.review`;
    const tool = (name: string) =>
      customToolSchema.parse({
        name,
        description: 'Fetches the status.',
        action: 'http-get',
        url: 'https://api.example.com/v1/status',
      });
    const store = async (tools: unknown[]) => {
      const stored = { ...promptStep('Check {{task.title}}'), tools };
      await db.insert(schema.taskTypeDefinitions).values({
        slug: BAD_TYPE,
        displayName: 'Bad tool',
        runListStrategy: 'static',
        stepIds: ['tcs-a', BAD_ID],
        promptSteps: { review: stored },
        source: 'admin',
      });
      return stored;
    };
    const pinnedOf = async (taskId: string) =>
      JSON.parse((await customStepsText(taskId))!) as Record<string, unknown>;

    it('pins both tools as stored with no invalidTools, and a read of the pin names the broken one', async () => {
      const stored = await store([
        tool('good_tool'),
        { ...tool('bad_tool'), description: 'd'.repeat(1025) },
      ]);
      const { task } = await insertTask(BAD_TYPE);
      const pinned = await pinnedOf(task.id);
      expect(pinned[BAD_ID]).toEqual(stored);
      expect(pinned[BAD_ID]).not.toHaveProperty('invalidTools');
      const read = parsePinnedCustomSteps(pinned)[BAD_ID];
      expect(read?.tools.map((t) => t.name)).toEqual(['good_tool']);
      expect(read?.invalidTools).toEqual(['bad_tool']);
    });

    it('pins a step whose tools all parse as stored, and a read of the pin has no invalidTools', async () => {
      const stored = await store([tool('good_tool')]);
      const { task } = await insertTask(BAD_TYPE);
      const pinned = await pinnedOf(task.id);
      expect(pinned[BAD_ID]).toEqual(stored);
      expect(parsePinnedCustomSteps(pinned)[BAD_ID]).not.toHaveProperty('invalidTools');
    });
  });

  describe('start gate: unusable pinned custom tools', () => {
    const GATE = 'tcs-gate';
    const GATE_ID = `custom.${GATE}.review`;
    const goodTool = (name: string, extra: Record<string, unknown> = {}) =>
      customToolSchema.parse({
        name,
        description: 'Fetches the status.',
        action: 'http-get',
        url: 'https://api.example.com/v1/status',
        ...extra,
      });
    const storeType = async (
      tools: unknown[],
      opts: { requiresRepository?: boolean; slug?: string; title?: string } = {},
    ) => {
      const slug = opts.slug ?? GATE;
      await db.insert(schema.taskTypeDefinitions).values({
        slug,
        displayName: 'Gate',
        runListStrategy: 'static',
        stepIds: ['tcs-a', `custom.${slug}.review`],
        promptSteps: {
          review: {
            ...promptStep('Check {{task.title}}'),
            ...(opts.title ? { title: opts.title } : {}),
            tools,
          },
        },
        requiresRepository: opts.requiresRepository ?? true,
        source: 'admin',
      });
      return slug;
    };
    const action = (id: string, name: string) =>
      send('POST', `/tasks/${id}/action`, { action: name });
    const statusOf = async (id: string) =>
      (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!.status;
    const startAdds = () => h.adds.filter((a) => a.name === TASK_JOB_NAMES.START);
    const startedEvents = async (id: string) =>
      (await db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, id))).filter(
        (e) => e.eventType === 'task.started',
      );
    const expectRefused = async (res: Response, code: string, ...parts: string[]) => {
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe(code);
      for (const part of parts) expect(body.error).toContain(part);
    };
    const expectNothingStarted = async (id: string, status = 'created') => {
      expect(await statusOf(id)).toBe(status);
      expect(startAdds()).toEqual([]);
      expect(await startedEvents(id)).toEqual([]);
    };
    const badUrlTool = () => goodTool('ip_tool', { url: 'https://127.0.0.1/status' });
    const problemOf = (tool: ReturnType<typeof badUrlTool>, requiresRepository: boolean) =>
      validateCustomTools([tool], { requiresRepository })[0]!;
    const ragProject = () =>
      customToolSchema.parse({
        name: 'rag_tool',
        description: 'Searches.',
        action: 'rag-query',
        scope: 'project',
      });

    it('start gate: refuses a tool whose URL now fails validation', async () => {
      const tool = badUrlTool();
      const problem = problemOf(tool, true);
      expect(problem.kind).toBe('tool-host-ip-literal');
      await storeType([tool]);
      const { task } = await insertTask(GATE, 'created');
      await expectRefused(
        await action(task.id, 'start'),
        'custom-tool-invalid',
        'Review step',
        '`ip_tool`',
        problem.message,
      );
      await expectNothingStarted(task.id);
    });

    it('start gate: refuses a tool that no longer parses', async () => {
      await storeType([
        goodTool('good_tool'),
        { ...goodTool('bad_tool'), description: 'd'.repeat(1025) },
      ]);
      const { task } = await insertTask(GATE, 'created');
      await expectRefused(
        await action(task.id, 'start'),
        'custom-tool-invalid',
        'Review step',
        describeInvalidTools(['bad_tool']),
      );
      await expectNothingStarted(task.id);
    });

    it('start gate: carries a stored step title on one line, cut like a tool name', async () => {
      const title = `Audit \`it\`\n${'t'.repeat(200)}`;
      const refusal = async (slug: string) => {
        const { task } = await insertTask(slug, 'created');
        return ((await (await action(task.id, 'start')).json()) as { error: string }).error;
      };
      await storeType([badUrlTool()], { title });
      await storeType([goodTool('good_tool')], { title, slug: 'tcs-gate-title-off' });
      h.switchOn = false;
      for (const [slug, text] of [
        [GATE, 'has custom tools'],
        ['tcs-gate-title-off', 'uses custom tools'],
      ] as const) {
        const error = await refusal(slug);
        expect(error).toContain(`The step "${shownToolName(title)}" ${text}`);
        expect(error).not.toContain('\n');
        expect(error.length).toBeLessThan(400);
      }
    });

    it('start gate: judges the tool scope by the type repository flag', async () => {
      const tool = ragProject();
      const problem = problemOf(tool, false);
      expect(problem.kind).toBe('tool-scope-needs-repository');
      await storeType([tool], { requiresRepository: false });
      const { task } = await insertTask(GATE, 'created');
      await expectRefused(await action(task.id, 'start'), 'custom-tool-invalid', problem.message);
      await expectNothingStarted(task.id);

      await storeType([tool], { requiresRepository: true, slug: 'tcs-gate-repo' });
      const { task: ok } = await insertTask('tcs-gate-repo', 'created');
      const res = await action(ok.id, 'start');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, started: true, status: 'queued' });
    });

    it('start gate: refuses valid tools while the switch is off, and starts them when it is on', async () => {
      await storeType([goodTool('good_tool')]);
      const { task } = await insertTask(GATE, 'created');
      h.switchOn = false;
      await expectRefused(
        await action(task.id, 'start'),
        'custom-tools-switched-off',
        'Review step',
        '`good_tool`',
        'switched off',
      );
      await expectNothingStarted(task.id);

      h.switchOn = true;
      const res = await action(task.id, 'start');
      expect(await res.json()).toEqual({ ok: true, started: true, status: 'queued' });
      expect(await statusOf(task.id)).toBe('queued');
      expect(startAdds()).toHaveLength(1);
    });

    it('start gate: a config store outage answers 503 and starts nothing', async () => {
      await storeType([goodTool('good_tool')]);
      const { task } = await insertTask(GATE, 'created');
      h.switchOutage = true;
      const res = await action(task.id, 'start');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'config_unavailable' });
      await expectNothingStarted(task.id);

      h.switchOutage = false;
      expect(await (await action(task.id, 'start')).json()).toMatchObject({ started: true });
    });

    it('start gate: an unusable tool wins over the switch', async () => {
      await storeType([badUrlTool()]);
      const { task } = await insertTask(GATE, 'created');
      h.switchOn = false;
      await expectRefused(await action(task.id, 'start'), 'custom-tool-invalid', '`ip_tool`');
      await expectNothingStarted(task.id);
    });

    it('start gate: markQueuedForStart rejects with a 409 HttpError', async () => {
      await storeType([badUrlTool()]);
      const { task } = await insertTask(GATE, 'created');
      const err = await markQueuedForStart(db, task.id).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 409, code: 'custom-tool-invalid' });
      await expectNothingStarted(task.id);
    });

    it('start gate: a full retry of a failed task with no step row is refused', async () => {
      await storeType([badUrlTool()]);
      const { task } = await insertTask(GATE, 'failed');
      await expectRefused(await action(task.id, 'retry'), 'custom-tool-invalid', '`ip_tool`');
      expect(await statusOf(task.id)).toBe('failed');
      expect(h.adds).toEqual([]);
    });

    it('start gate: a retry at an existing step row is not gated', async () => {
      await storeType([goodTool('good_tool')]);
      const { task } = await insertTask(GATE, 'failed');
      await db.insert(schema.taskSteps).values({
        taskId: task.id,
        stepId: GATE_ID,
        stepIndex: 1,
        title: 'Review step',
        status: 'failed',
      });
      await db
        .update(schema.tasks)
        .set({ currentStepId: GATE_ID })
        .where(eq(schema.tasks.id, task.id));
      h.switchOn = false;
      const res = await action(task.id, 'retry');
      const body = (await res.json()) as { code?: string };
      expect(body.code ?? '').not.toMatch(/^custom-tool/);
    });

    it('start gate: create-and-start refuses and leaves no row', async () => {
      await storeType([goodTool('good_tool')], { requiresRepository: false });
      h.switchOn = false;
      const res = await send('POST', '/tasks', {
        type: GATE,
        title: 'gate-create',
        description: 'x',
      });
      await expectRefused(res, 'custom-tools-switched-off', '`good_tool`');
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.title, 'gate-create'));
      expect(rows).toEqual([]);
    });

    it('start gate: a deferred create succeeds and the later start refuses', async () => {
      await storeType([goodTool('good_tool')]);
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId: ACTOR_ID,
          name: 'tcs-gate-repo',
          status: 'ready',
          source: 'local_path',
          localPath: '/tmp/tcs-gate',
          writable: true,
          storagePath: '/tmp/tcs-gate-store',
        })
        .returning();
      h.switchOn = false;
      const res = await send('POST', '/tasks', {
        type: GATE,
        title: 'gate-defer',
        description: 'x',
        repositoryId: repo!.id,
        deferStart: true,
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { task?: { id: string }; id?: string };
      const id = created.task?.id ?? created.id!;
      expect(await statusOf(id)).toBe('created');
      await expectRefused(await action(id, 'start'), 'custom-tools-switched-off');
      await expectNothingStarted(id);
    });

    it('start gate: a repeat start of a started task stays a no-op with the switch off', async () => {
      await storeType([goodTool('good_tool')]);
      const { task } = await insertTask(GATE, 'running');
      h.switchOn = false;
      const res = await action(task.id, 'start');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, started: false });
    });

    it('start gate: a task without pinned tools never reads the switch', async () => {
      const { task: bare } = await insertTask(TYPE, 'created');
      await storeType([], { slug: 'tcs-gate-empty' });
      const { task: empty } = await insertTask('tcs-gate-empty', 'created');
      await db.update(schema.tasks).set({ customSteps: null }).where(eq(schema.tasks.id, bare.id));
      for (const t of [bare, empty]) {
        const res = await action(t.id, 'start');
        expect(await res.json()).toMatchObject({ ok: true, started: true });
      }
      expect(h.switchReads).toBe(0);
    });
  });
});
