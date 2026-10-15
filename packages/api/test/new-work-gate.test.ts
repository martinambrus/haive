import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  gdb: undefined as unknown,
  state: 'normal',
  dbCalls: 0,
  queued: [] as string[],
  insertTask: (_args: Record<string, unknown>): string => '',
}));

vi.mock('../src/db.js', () => ({
  getDb: () => {
    h.dbCalls += 1;
    return h.db;
  },
}));
vi.mock('../src/queues.js', () => ({
  getTaskQueue: () => ({
    add: async (name: string) => {
      h.queued.push(name);
    },
  }),
  getGlobalKbSyncQueue: () => ({ add: async () => undefined }),
}));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));
vi.mock('../src/lib/spawn-plan-task.js', () => ({
  spawnPlanTask: async (args: {
    userId: string;
    repositoryId: string;
    type: string;
    title: string;
    seed?: (id: string) => Promise<void>;
  }) => {
    const id = h.insertTask({
      userId: args.userId,
      repositoryId: args.repositoryId,
      type: args.type,
      title: args.title,
      status: 'created',
    });
    await args.seed?.(id);
    return id;
  },
  enqueuePlanTask: async () => undefined,
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('../src/lib/task-type-definition.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/task-type-definition.js')>()),
  definitionForCreate: async () => ({ runListSnapshot: null }),
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({ db: h.gdb, settings: { namespace: 'default' } }),
}));

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, TASK_JOB_NAMES } from '@haive/shared';
import { globalKbEntries } from '@haive/shared/global-kb';
import { globalKbRoutes } from '../src/routes/global-kb.js';
import { planRoutes } from '../src/routes/plan.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { upgradeRoutes } from '../src/routes/upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { maintenanceGate } from '../src/middleware/maintenance.js';
import type { AppEnv } from '../src/context.js';
import { seedStepCatalog } from './step-flags-fixture.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const PROVIDER = '00000000-0000-4000-8000-0000000000c1';
const NODE = '00000000-0000-4000-8000-0000000000d1';
const REFUSAL =
  'Haive is preparing for maintenance, so new tasks are not being started. Work already running will finish.';

const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set('maintenanceState', h.state as 'normal');
  await next();
});
app.route('/tasks', taskRoutes);
app.route('/repositories', upgradeRoutes);
app.route('/repositories', planRoutes);
app.route('/global-kb', globalKbRoutes);
app.onError(errorHandler);

const ROUTES: { name: string; path: string; body: unknown }[] = [
  {
    name: 'POST /tasks',
    path: '/tasks',
    body: { type: 'workflow', title: 'a task', description: 'do it', repositoryId: REPO },
  },
  {
    name: 'POST /repositories/:id/rollback-upgrade',
    path: `/repositories/${REPO}/rollback-upgrade`,
  },
  {
    name: 'POST /repositories/:id/plan/build',
    path: `/repositories/${REPO}/plan/build`,
    body: { mode: 'from_repo' },
  },
  { name: 'POST /repositories/:id/plan/sequence', path: `/repositories/${REPO}/plan/sequence` },
  { name: 'POST /repositories/:id/plan/merge', path: `/repositories/${REPO}/plan/merge` },
  {
    name: 'POST /repositories/:id/plan/nodes/:nodeId/chat',
    path: `/repositories/${REPO}/plan/nodes/${NODE}/chat`,
    body: { message: 'Split payments out.' },
  },
  {
    name: 'POST /repositories/:id/plan/nodes/:nodeId/advisory',
    path: `/repositories/${REPO}/plan/nodes/${NODE}/advisory`,
    body: { question: 'Which queue?' },
  },
  {
    name: 'POST /global-kb/enrich',
    path: '/global-kb/enrich',
    body: { title: 'Never inline SVG', seedText: 'bloats the cache', cliProviderId: PROVIDER },
  },
].map((r) => ({ body: {}, ...r }));

function setup() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    cliProviders: schema.cliProviders,
    planNodes: schema.planNodes,
    planNodeMessages: schema.planNodeMessages,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateConflicts: schema.projectStateConflicts,
    taskDatabaseStates: schema.taskDatabaseStates,
    repositoryDatabaseStates: schema.repositoryDatabaseStates,
    databaseSnapshots: schema.databaseSnapshots,
    globalKbEntries,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  fake.insert(schema.cliProviders, {
    id: PROVIDER,
    userId: USER,
    name: 'claude-code',
    label: 'claude-code',
    enabled: true,
  });
  fake.insert(schema.planNodes, {
    id: NODE,
    repositoryId: REPO,
    parentId: null,
    path: `/${NODE}/`,
    title: 'Root',
    ordinal: 0,
    kind: 'component',
    status: 'todo',
    version: 1,
  });
  for (const type of ['onboarding', 'onboarding_upgrade']) {
    fake.insert(schema.tasks, {
      userId: USER,
      repositoryId: REPO,
      type,
      title: type,
      status: 'completed',
      completedAt: new Date(0),
    });
  }
  h.db = fake.db;
  h.gdb = fake.db;
  h.insertTask = (args) => fake.insert(schema.tasks, args).id as string;
  h.dbCalls = 0;
  return { fake, seeded: fake.rows(schema.tasks).length };
}

const request = ({ body }: { body: unknown }) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const post = (route: { path: string; body: unknown }) => app.request(route.path, request(route));

beforeEach(() => {
  h.state = 'normal';
  vi.spyOn(configService, 'get').mockResolvedValue('true');
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
});

describe.each(ROUTES)('$name', (route) => {
  it('creates a task while the system is normal', async () => {
    const { fake, seeded } = setup();

    expect((await post(route)).status).toBe(201);
    expect(fake.rows(schema.tasks).length).toBe(seeded + 1);
  });

  it.each(['draining', 'maintenance'])(
    'answers 503 and creates no task while the system is %s',
    async (state) => {
      const { fake, seeded } = setup();
      h.state = state;

      const res = await post(route);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(fake.rows(schema.tasks).length).toBe(seeded);
      expect(fake.rows(globalKbEntries)).toEqual([]);
      expect(h.dbCalls).toBe(0);
    },
  );
});

describe('with the real maintenance gate in front', () => {
  it('takes the stored state from it, so a drain refuses and normal accepts', async () => {
    const gated = new Hono<AppEnv>();
    gated.use('*', maintenanceGate);
    gated.route('/tasks', taskRoutes);
    gated.onError(errorHandler);
    const { fake, seeded } = setup();

    vi.spyOn(configService, 'get').mockResolvedValue('draining');
    expect((await gated.request('/tasks', request(ROUTES[0]!))).status).toBe(503);
    expect(fake.rows(schema.tasks).length).toBe(seeded);

    vi.spyOn(configService, 'get').mockResolvedValue('normal');
    expect((await gated.request('/tasks', request(ROUTES[0]!))).status).toBe(201);
  });
});

describe('POST /tasks/:id/action', () => {
  const TASK = '00000000-0000-4000-8000-0000000000e1';
  const act = (action: string) =>
    app.request(`/tasks/${TASK}/action`, request({ body: { action } }));
  const withTask = (row: Record<string, unknown>) => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskEvents: schema.taskEvents,
      cliInvocations: schema.cliInvocations,
    });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      type: 'workflow',
      title: 'a task',
      orchestrationEpoch: 1,
      currentRound: 0,
      ...row,
    });
    h.db = fake.db;
    h.queued = [];
    return fake;
  };
  const written = (fake: ReturnType<typeof withTask>) => [
    fake.rows(schema.tasks),
    fake.rows(schema.taskEvents),
  ];

  describe.each([
    { action: 'start', row: { status: 'created' } },
    { action: 'retry', row: { status: 'failed', errorMessage: 'boom', completedAt: new Date(0) } },
  ])('$action', ({ action, row }) => {
    it('queues the task while the system is normal', async () => {
      withTask(row);

      expect((await act(action)).status).toBe(200);
      expect(h.queued).toEqual([TASK_JOB_NAMES.START]);
    });

    it.each(['draining', 'maintenance'])(
      'answers 503 and queues and writes nothing while the system is %s',
      async (state) => {
        const fake = withTask(row);
        const before = written(fake);
        h.state = state;

        const res = await act(action);

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: REFUSAL, code: null });
        expect(h.queued).toEqual([]);
        expect(written(fake)).toEqual(before);
      },
    );
  });

  describe('while the system drains', () => {
    beforeEach(() => {
      h.state = 'draining';
    });

    it('still pauses a task', async () => {
      const fake = withTask({ status: 'running' });

      expect((await act('pause')).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeInstanceOf(Date);
      expect(h.queued).toEqual([]);
    });

    it('still resumes a paused task', async () => {
      const fake = withTask({ status: 'running', pausedAt: new Date(0) });

      expect((await act('resume')).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]?.pausedAt).toBeNull();
      expect(h.queued).toEqual([]);
    });

    it('still cancels a task and queues its teardown', async () => {
      const fake = withTask({ status: 'running' });

      expect((await act('cancel')).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'cancelled' });
      expect(h.queued).toEqual([TASK_JOB_NAMES.CANCEL]);
    });
  });
});

describe('POST /tasks/:id/steps/:stepId/action', () => {
  const TASK = '00000000-0000-4000-8000-0000000000e1';
  const STEP = '11d-skill-sync';
  const STEP_ROW = '00000000-0000-4000-8000-0000000000e2';
  const act = (action: string) =>
    app.request(`/tasks/${TASK}/steps/${STEP}/action`, request({ body: { action, round: 0 } }));
  const withFailedStep = () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskEvents: schema.taskEvents,
      cliInvocations: schema.cliInvocations,
      taskStepAgentMinings: schema.taskStepAgentMinings,
      taskDagPlans: schema.taskDagPlans,
      stepCatalog: schema.stepCatalog,
    });
    seedStepCatalog(fake);
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      type: 'workflow',
      title: 'a task',
      status: 'failed',
      errorMessage: 'boom',
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
    h.queued = [];
    return fake;
  };
  const written = (fake: ReturnType<typeof withFailedStep>) =>
    [
      schema.tasks,
      schema.taskSteps,
      schema.taskEvents,
      schema.cliInvocations,
      schema.taskStepAgentMinings,
    ].map((table) => fake.rows(table));

  describe.each(['retry', 'retry_ai', 'skip'])('%s', (action) => {
    it('moves the task back to the step while the system is normal', async () => {
      const fake = withFailedStep();

      expect((await act(action)).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running' });
      expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
    });

    it.each(['draining', 'maintenance'])(
      'answers 503 and queues and writes nothing while the system is %s',
      async (state) => {
        const fake = withFailedStep();
        const before = written(fake);
        h.state = state;

        const res = await act(action);

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: REFUSAL, code: null });
        expect(h.queued).toEqual([]);
        expect(written(fake)).toEqual(before);
      },
    );
  });

  describe('resume', () => {
    it.each(['normal', 'draining'])(
      'still re-runs the failed agents while the system is %s',
      async (state) => {
        const fake = withFailedStep();
        h.state = state;

        expect((await act('resume')).status).toBe(200);
        expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running' });
        expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
      },
    );
  });
});

describe('the code that creates a task', () => {
  it('sits only in files whose routes are gated and listed above', () => {
    const src = join(import.meta.dirname, '../src');
    const creators = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /\.insert\(schema\.tasks\)|\bspawnPlanTask\(/.test(readFileSync(join(src, file), 'utf8')),
      )
      .sort();

    expect(
      creators,
      'a new file creates tasks: gate its routes with requireNewWorkAllowed and add them to ROUTES',
    ).toEqual([
      'lib/spawn-plan-task.ts',
      'routes/global-kb.ts',
      'routes/plan.ts',
      'routes/tasks/index.ts',
      'routes/upgrades.ts',
    ]);
  });
});
