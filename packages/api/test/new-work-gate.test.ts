import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  gdb: undefined as unknown,
  state: 'normal',
  dbCalls: 0,
  queued: [] as string[],
  jobs: [] as string[],
}));

vi.mock('../src/db.js', () => ({
  getDb: () => {
    h.dbCalls += 1;
    return h.db;
  },
}));
vi.mock('../src/queues.js', () => {
  const jobQueue = () => ({
    getRanges: async () => [],
    getJobs: async () => [],
    add: async (name: string) => {
      h.jobs.push(name);
    },
    getJob: async () => undefined,
  });
  return {
    getTaskQueue: () => ({
      add: async (name: string) => {
        h.queued.push(name);
      },
    }),
    getGlobalKbSyncQueue: () => ({ add: async () => undefined }),
    getRepoQueue: jobQueue,
    getBundleQueue: jobQueue,
    getCliExecQueue: jobQueue,
    getUsagePollQueue: jobQueue,
  };
});
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
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
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import {
  BUNDLE_JOB_NAMES,
  CLI_EXEC_JOB_NAMES,
  configService,
  DEFAULT_AGENT_RULES,
  REPO_JOB_NAMES,
  TASK_JOB_NAMES,
} from '@haive/shared';
import { globalKbEntries } from '@haive/shared/global-kb';
import { bundleRoutes } from '../src/routes/bundles.js';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { globalKbRoutes } from '../src/routes/global-kb.js';
import { planRoutes } from '../src/routes/plan.js';
import { repoRoutes } from '../src/routes/repos.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { taskTypeDraftRoutes } from '../src/routes/task-type-drafts.js';
import { upgradeRoutes } from '../src/routes/upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { maintenanceGate } from '../src/middleware/maintenance.js';
import type { AppEnv } from '../src/context.js';
import { seedStepCatalog } from './step-flags-fixture.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const PROVIDER = '00000000-0000-4000-8000-0000000000c1';
const NODE = '00000000-0000-4000-8000-0000000000d1';
const REFUSAL =
  'Haive is preparing for maintenance, so new work is not being started. Work already running will finish.';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/repositories', upgradeRoutes);
app.route('/repositories', planRoutes);
app.route('/global-kb', globalKbRoutes);
app.route('/admin/task-type-drafts', taskTypeDraftRoutes);
app.onError(errorHandler);

const gated = new Hono<AppEnv>();
gated.use('*', maintenanceGate);
gated.route('/tasks', taskRoutes);
gated.route('/repositories', upgradeRoutes);
gated.route('/repositories', planRoutes);
gated.route('/global-kb', globalKbRoutes);
gated.route('/admin/task-type-drafts', taskTypeDraftRoutes);
gated.onError(errorHandler);

/** What the cached read answers, and what the stored state is when it is read past the cache. */
const states = (cached: string, stored: string) => {
  vi.spyOn(configService, 'get').mockResolvedValue(cached);
  return vi.spyOn(configService, 'getFresh').mockClear().mockResolvedValue(stored);
};

/** The state is normal at the early check and draining by the time the transaction admits the work. */
const turnsDrainingAfterTheEarlyCheck = () => {
  h.state = 'draining';
  return vi.spyOn(configService, 'getFresh').mockClear().mockResolvedValueOnce('normal');
};

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
    name: 'POST /admin/task-type-drafts',
    path: '/admin/task-type-drafts',
    body: { message: 'Draft a step that greets the user.' },
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
  vi.spyOn(configService, 'getFresh').mockImplementation(async () => h.state);
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

  it('answers 503 and creates no task when the state turns draining after the early check', async () => {
    const { fake, seeded } = setup();
    const stored = turnsDrainingAfterTheEarlyCheck();

    const res = await post(route);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: REFUSAL, code: null });
    expect(fake.rows(schema.tasks).length).toBe(seeded);
    expect(fake.rows(globalKbEntries)).toEqual([]);
    expect(stored).toHaveBeenCalledTimes(2);
  });

  describe('behind the real maintenance gate', () => {
    it('creates a task when the cached copy and the stored state both say normal', async () => {
      const { fake, seeded } = setup();
      states('normal', 'normal');

      expect((await gated.request(route.path, request(route))).status).toBe(201);
      expect(fake.rows(schema.tasks).length).toBe(seeded + 1);
    });

    it.each(['draining', 'maintenance'])(
      'answers 503 and creates no task when only the stored state is %s, the cached copy still saying normal',
      async (stored) => {
        const { fake, seeded } = setup();
        states('normal', stored);

        const res = await gated.request(route.path, request(route));

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: REFUSAL, code: null });
        expect(fake.rows(schema.tasks).length).toBe(seeded);
        expect(fake.rows(globalKbEntries)).toEqual([]);
        expect(h.dbCalls).toBe(0);
      },
    );

    it('creates a task when a drain was lifted after the cached copy was read', async () => {
      const { fake, seeded } = setup();
      states('draining', 'normal');

      expect((await gated.request(route.path, request(route))).status).toBe(201);
      expect(fake.rows(schema.tasks).length).toBe(seeded + 1);
    });
  });
});

describe('the real maintenance gate', () => {
  it('locks a non-admin out on its cached read, without reading the stored state', async () => {
    const { fake, seeded } = setup();
    const stored = states('maintenance', 'normal');

    const res = await gated.request('/tasks', request(ROUTES[0]!));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ maintenance: 'maintenance' });
    expect(fake.rows(schema.tasks).length).toBe(seeded);
    expect(stored).not.toHaveBeenCalled();
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

    it('answers 503 and queues and writes nothing when the state turns draining after the early check', async () => {
      const fake = withTask(row);
      const before = written(fake);
      const stored = turnsDrainingAfterTheEarlyCheck();

      const res = await act(action);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(h.queued).toEqual([]);
      expect(written(fake)).toEqual(before);
      expect(stored).toHaveBeenCalledTimes(2);
    });
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

  describe.each(['retry', 'retry_ai', 'skip', 'resume'])('%s', (action) => {
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

    it('answers 503 and queues and writes nothing when the state turns draining after the early check', async () => {
      const fake = withFailedStep();
      const before = written(fake);
      const stored = turnsDrainingAfterTheEarlyCheck();

      const res = await act(action);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(h.queued).toEqual([]);
      expect(written(fake)).toEqual(before);
      expect(stored).toHaveBeenCalledTimes(2);
    });
  });

  describe('resume of a step that failed in the middle of a loop', () => {
    const withFailedLoopStep = async () => {
      const fake = withFailedStep();
      await fake.db
        .delete(schema.taskStepAgentMinings)
        .where(eq(schema.taskStepAgentMinings.taskStepId, STEP_ROW));
      fake.patch(schema.taskSteps, STEP_ROW, { iterationCount: 1 });
      return fake;
    };

    it('moves the task back to the step while the system is normal', async () => {
      const fake = await withFailedLoopStep();

      expect((await act('resume')).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running' });
      expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
    });

    it('answers 503 and queues and writes nothing when the state turns draining after the early check', async () => {
      const fake = await withFailedLoopStep();
      const before = written(fake);
      const stored = turnsDrainingAfterTheEarlyCheck();

      const res = await act('resume');

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(h.queued).toEqual([]);
      expect(written(fake)).toEqual(before);
      expect(stored).toHaveBeenCalledTimes(2);
    });
  });

  describe('the task retry, which moves a task back to its failed step', () => {
    const retryTask = () =>
      app.request(`/tasks/${TASK}/action`, request({ body: { action: 'retry' } }));

    it('moves the task back to the step while the system is normal', async () => {
      const fake = withFailedStep();

      expect((await retryTask()).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running' });
      expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
    });

    it('answers 503 and queues and writes nothing when the state turns draining after the early check', async () => {
      const fake = withFailedStep();
      const before = written(fake);
      const stored = turnsDrainingAfterTheEarlyCheck();

      const res = await retryTask();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(h.queued).toEqual([]);
      expect(written(fake)).toEqual(before);
      expect(stored).toHaveBeenCalledTimes(2);
    });
  });

  describe('abort', () => {
    it('still cancels the task and queues its teardown while the system drains', async () => {
      const fake = withFailedStep();
      h.state = 'draining';

      expect((await act('abort')).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'cancelled' });
      expect(h.queued).toEqual([TASK_JOB_NAMES.CANCEL]);
    });
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
      'routes/task-type-drafts.ts',
      'routes/tasks/index.ts',
      'routes/upgrades.ts',
    ]);
  });

  it('takes the new-work fence in every file that inserts a task itself', () => {
    const src = join(import.meta.dirname, '../src');
    const unfenced = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => {
        const text = readFileSync(join(src, file), 'utf8');
        return /\.insert\(schema\.tasks\)/.test(text) && !/\badmitNewWork\(/.test(text);
      })
      .sort();

    expect(
      unfenced,
      'a file that inserts a task must call admitNewWork in the transaction that writes it',
    ).toEqual([]);
  });
});

describe('PATCH /tasks/:id/steps/:stepId/cli-provider', () => {
  const TASK = '00000000-0000-4000-8000-0000000000e1';
  const STEP = '11d-skill-sync';
  const UPCOMING = '08c-code-review';
  const pick = (body: Record<string, unknown> = {}, stepId = STEP) =>
    app.request(`/tasks/${TASK}/steps/${stepId}/cli-provider`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliProviderId: null, round: 0, ...body }),
    });
  const withStep = (step: Record<string, unknown>, task: Record<string, unknown> = {}) => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskEvents: schema.taskEvents,
      cliInvocations: schema.cliInvocations,
      taskStepAgentMinings: schema.taskStepAgentMinings,
      taskStepCliChoices: schema.taskStepCliChoices,
      stepCatalog: schema.stepCatalog,
      cliProviders: schema.cliProviders,
    });
    seedStepCatalog(fake);
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      name: 'claude-code',
      label: 'claude-code',
      enabled: true,
    });
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
      ...task,
    });
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: STEP,
      stepIndex: 1,
      runSeq: 1,
      round: 0,
      iterationCount: 0,
      idleMs: 0,
      userActiveMs: 0,
      carriedWorkMs: 0,
      carriedIdleMs: 0,
      carriedUserActiveMs: 0,
      ...step,
    });
    h.db = fake.db;
    h.queued = [];
    return fake;
  };
  const written = (fake: ReturnType<typeof withStep>) =>
    [
      schema.tasks,
      schema.taskSteps,
      schema.taskEvents,
      schema.cliInvocations,
      schema.taskStepAgentMinings,
      schema.taskStepCliChoices,
    ].map((table) => fake.rows(table));

  describe.each([
    { status: 'failed', task: { status: 'failed' } },
    { status: 'waiting_form', task: { status: 'waiting_user', errorMessage: null } },
  ])('on a $status step, which the pick re-runs', ({ status, task }) => {
    it('re-runs the step on the new CLI while the system is normal', async () => {
      const fake = withStep({ status }, task);

      expect((await pick()).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running' });
      expect(fake.rows(schema.taskStepCliChoices)).toHaveLength(1);
      expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
    });

    it.each(['draining', 'maintenance'])(
      'answers 503 and changes and queues nothing while the system is %s',
      async (state) => {
        const fake = withStep({ status }, task);
        const before = written(fake);
        h.state = state;

        const res = await pick();

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: REFUSAL, code: null });
        expect(h.queued).toEqual([]);
        expect(written(fake)).toEqual(before);
      },
    );

    it('answers 503 and re-runs and queues nothing when the state turns draining after the early check', async () => {
      const fake = withStep({ status }, task);
      const rerun = () =>
        [schema.tasks, schema.taskSteps, schema.taskEvents, schema.cliInvocations].map((table) =>
          fake.rows(table),
        );
      const before = rerun();
      const stored = turnsDrainingAfterTheEarlyCheck();

      const res = await pick();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(h.queued).toEqual([]);
      expect(rerun()).toEqual(before);
      expect(stored).toHaveBeenCalledTimes(2);
    });

    it('answers 503 and saves no CLI choice when the state turns draining after the early check', async () => {
      const fake = withStep({ status }, task);
      const before = written(fake);
      turnsDrainingAfterTheEarlyCheck();

      const res = await pick({ cliProviderId: PROVIDER });

      expect(res.status).toBe(503);
      expect(written(fake)).toEqual(before);
    });
  });

  describe('on the model-health canary, whose pick rewrites the task default', () => {
    const CANARY = '00-model-health-workflow';
    const onCanary = () =>
      withStep({ status: 'failed', stepId: CANARY }, { currentStepId: CANARY });

    it('re-runs the canary and rewrites the task default while the system is normal', async () => {
      const fake = onCanary();

      expect((await pick({ cliProviderId: PROVIDER }, CANARY)).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({
        status: 'running',
        cliProviderId: PROVIDER,
      });
      expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([
        { stepId: CANARY, cliProviderId: PROVIDER },
      ]);
    });

    it('answers 503 and leaves the task default when the state turns draining after the early check', async () => {
      const fake = onCanary();
      const before = written(fake);
      turnsDrainingAfterTheEarlyCheck();

      const res = await pick({ cliProviderId: PROVIDER }, CANARY);

      expect(res.status).toBe(503);
      expect(written(fake)).toEqual(before);
    });
  });

  describe('while the system drains, a pick that re-runs nothing', () => {
    beforeEach(() => {
      h.state = 'draining';
    });

    it.each([
      { name: 'a pending step', step: { status: 'pending' } },
      {
        name: 'a failed step in the middle of a loop',
        step: { status: 'failed', iterationCount: 1 },
      },
    ])('is saved on $name', async ({ step }) => {
      const fake = withStep(step);

      expect((await pick()).status).toBe(200);
      expect(fake.rows(schema.taskStepCliChoices)).toHaveLength(1);
      expect(h.queued).toEqual([]);
    });

    it('is saved for a named role of a failed step', async () => {
      const fake = withStep({ status: 'failed' });

      expect((await pick({ role: 'fixer' })).status).toBe(200);
      expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([{ role: 'fixer' }]);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'failed' });
      expect(h.queued).toEqual([]);
    });

    it('is saved for a step the run has not reached', async () => {
      const fake = withStep({ status: 'failed' });

      expect((await pick({ round: undefined }, UPCOMING)).status).toBe(200);
      expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([{ stepId: UPCOMING }]);
      expect(h.queued).toEqual([]);
    });
  });
});

describe.each([
  { route: 'submit', body: { values: { choice: 'yes' } } },
  { route: 'clarify', body: { answer: 'Keep the incoming change.' } },
])('POST /tasks/:id/steps/:stepId/$route', ({ route, body }) => {
  const TASK = '00000000-0000-4000-8000-0000000000e1';
  const STEP = '11d-skill-sync';
  const answer = () => app.request(`/tasks/${TASK}/steps/${STEP}/${route}`, request({ body }));
  const withParkedForm = (status: string) => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskEvents: schema.taskEvents,
    });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      type: 'workflow',
      title: 'a task',
      status,
      errorMessage: status === 'failed' ? 'boom' : null,
      completedAt: status === 'failed' ? new Date(0) : null,
      awaitingProviderReason: status === 'failed' ? 'rate_limit' : null,
      awaitingProviderSince: status === 'failed' ? new Date(0) : null,
      orchestrationEpoch: 3,
      currentStepId: STEP,
      currentRound: 0,
    });
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: STEP,
      stepIndex: 1,
      runSeq: 1,
      round: 0,
      status: 'waiting_form',
      idleMs: 0,
      waitingStartedAt: new Date(0),
    });
    h.db = fake.db;
    h.queued = [];
    return fake;
  };
  const written = (fake: ReturnType<typeof withParkedForm>) =>
    [schema.tasks, schema.taskSteps, schema.taskEvents].map((table) => fake.rows(table));

  it('queues the answer to a failed task while the system is normal', async () => {
    const fake = withParkedForm('failed');

    expect((await answer()).status).toBe(200);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({
      status: 'running',
      errorMessage: null,
      completedAt: null,
      awaitingProviderReason: null,
      awaitingProviderSince: null,
    });
    expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ waitingStartedAt: null });
    expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
  });

  it('reopens a failed task in the transaction that writes the answer', async () => {
    const fake = withParkedForm('failed');
    const before = written(fake);
    let atCommit: unknown;
    fake.hooks.beforeCommit = () => {
      atCommit = fake.rows(schema.tasks)[0]?.status;
      throw new Error('commit failed');
    };

    expect((await answer()).status).toBe(500);

    expect(atCommit).toBe('running');
    expect(written(fake)).toEqual(before);
    expect(h.queued).toEqual([]);
  });

  it.each(['draining', 'maintenance'])(
    'answers 503 and queues and writes nothing for a failed task while the system is %s',
    async (state) => {
      const fake = withParkedForm('failed');
      const before = written(fake);
      h.state = state;

      const res = await answer();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(h.queued).toEqual([]);
      expect(written(fake)).toEqual(before);
    },
  );

  it('answers 503 and queues and writes nothing for a failed task when the state turns draining after the early check', async () => {
    const fake = withParkedForm('failed');
    const before = written(fake);
    const stored = turnsDrainingAfterTheEarlyCheck();

    const res = await answer();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: REFUSAL, code: null });
    expect(h.queued).toEqual([]);
    expect(written(fake)).toEqual(before);
    expect(stored).toHaveBeenCalledTimes(2);
  });

  it.each(['waiting_user', 'running'])(
    'still takes the answer to a %s task while the system drains',
    async (status) => {
      const fake = withParkedForm(status);
      const tasksBefore = fake.rows(schema.tasks);
      h.state = 'draining';

      expect((await answer()).status).toBe(200);
      expect(fake.rows(schema.tasks)).toEqual(tasksBefore);
      expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ waitingStartedAt: null });
      expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
    },
  );

  describe('when the task changes after the route read it', () => {
    /** The route's own read answers as the task stood, and the task changes right after it. */
    const changesAfterTheRead = (
      fake: ReturnType<typeof withParkedForm>,
      row: Record<string, unknown>,
    ) => {
      const read = fake.db.query.tasks.findFirst;
      fake.db.query.tasks.findFirst = async (opts) => {
        const seen = await read(opts);
        fake.patch(schema.tasks, TASK, row);
        return seen;
      };
    };
    const failsAfterTheRead = (fake: ReturnType<typeof withParkedForm>) =>
      changesAfterTheRead(fake, { status: 'failed', errorMessage: 'boom' });

    it('answers 503 and queues and writes nothing for a task that failed meanwhile while the system drains', async () => {
      const fake = withParkedForm('waiting_user');
      failsAfterTheRead(fake);
      h.state = 'draining';

      const res = await answer();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(h.queued).toEqual([]);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'failed' });
      expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ waitingStartedAt: new Date(0) });
      expect(fake.rows(schema.taskEvents)).toEqual([]);
    });

    it('reads the stored state under the fence for a task that failed meanwhile', async () => {
      const fake = withParkedForm('waiting_user');
      failsAfterTheRead(fake);
      const stored = vi.spyOn(configService, 'getFresh').mockClear().mockResolvedValue('normal');

      expect((await answer()).status).toBe(200);

      expect(stored).toHaveBeenCalledTimes(1);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running' });
      expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
    });

    it('reads no state for a task that stays live, the answer reopening nothing', async () => {
      const fake = withParkedForm('waiting_user');
      const stored = vi.spyOn(configService, 'getFresh').mockClear().mockResolvedValue('draining');

      expect((await answer()).status).toBe(200);

      expect(stored).not.toHaveBeenCalled();
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'waiting_user' });
    });

    it('takes the answer to a task that was reopened meanwhile, though the system drains by then', async () => {
      const fake = withParkedForm('failed');
      changesAfterTheRead(fake, { status: 'waiting_user', errorMessage: null });
      const stored = turnsDrainingAfterTheEarlyCheck();

      expect((await answer()).status).toBe(200);

      expect(stored).toHaveBeenCalledTimes(1);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'waiting_user' });
      expect(fake.rows(schema.taskSteps)[0]).toMatchObject({ waitingStartedAt: null });
      expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
    });

    it('leaves a task that was cancelled after the answer read it failed cancelled', async () => {
      const fake = withParkedForm('failed');
      fake.hooks.beforeUpdate = (table) => {
        if (table !== schema.taskSteps) return;
        fake.patch(schema.tasks, TASK, { status: 'cancelled' });
      };

      expect((await answer()).status).toBe(200);

      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'cancelled' });
    });

    it('does not reopen a task that failed after the answer read its status, though the system drains', async () => {
      const fake = withParkedForm('waiting_user');
      h.state = 'draining';
      fake.hooks.beforeUpdate = (table) => {
        if (table !== schema.taskSteps) return;
        fake.patch(schema.tasks, TASK, { status: 'failed', errorMessage: 'boom' });
      };

      expect((await answer()).status).toBe(200);

      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'failed', errorMessage: 'boom' });
    });
  });

  describe('behind the real maintenance gate', () => {
    const answerThroughGate = () =>
      gated.request(`/tasks/${TASK}/steps/${STEP}/${route}`, request({ body }));

    it('queues the answer to a failed task when the cached copy and the stored state both say normal', async () => {
      const fake = withParkedForm('failed');
      states('normal', 'normal');

      expect((await answerThroughGate()).status).toBe(200);
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running' });
      expect(h.queued).toEqual([TASK_JOB_NAMES.ADVANCE_STEP]);
    });

    it.each(['draining', 'maintenance'])(
      'answers 503 and queues and writes nothing for a failed task when only the stored state is %s, the cached copy still saying normal',
      async (stored) => {
        const fake = withParkedForm('failed');
        const before = written(fake);
        states('normal', stored);

        const res = await answerThroughGate();

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: REFUSAL, code: null });
        expect(h.queued).toEqual([]);
        expect(written(fake)).toEqual(before);
      },
    );
  });
});

describe('the routes that start a background job', () => {
  const JOB_BUNDLE = '00000000-0000-4000-8000-0000000000f1';
  const JOB_UPLOAD = '00000000-0000-4000-8000-0000000000f2';
  const JOB_PROVIDER = '00000000-0000-4000-8000-0000000000f3';
  const JOB_TABLES = {
    auditEvents: schema.auditEvents,
    repositories: schema.repositories,
    repoUploads: schema.repoUploads,
    tasks: schema.tasks,
    customBundles: schema.customBundles,
    customBundleUploads: schema.customBundleUploads,
    customBundleItems: schema.customBundleItems,
    projectStateOutbox: schema.projectStateOutbox,
    cliProviders: schema.cliProviders,
    cliProviderSecrets: schema.cliProviderSecrets,
    cliPackageVersions: schema.cliPackageVersions,
  };

  const mountJobs = (target: Hono<AppEnv>) => {
    target.route('/repositories', repoRoutes);
    target.route('/bundles', bundleRoutes);
    target.route('/cli-providers', cliProviderRoutes);
    target.onError(errorHandler);
    return target;
  };
  const jobs = mountJobs(new Hono<AppEnv>());
  const gatedJobs = new Hono<AppEnv>();
  gatedJobs.use('*', maintenanceGate);
  mountJobs(gatedJobs);

  const jsonRequest = (method: string, body?: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  /** The fake defaults only id and createdAt, and cannot group: a bundle's response needs both. */
  const noRows = () => {
    const query: Record<string, unknown> = {};
    for (const method of ['where', 'groupBy']) query[method] = () => query;
    query.then = (ok: (rows: unknown[]) => unknown, bad: (err: unknown) => unknown) =>
      Promise.resolve([]).then(ok, bad);
    return query;
  };
  const answersBundles = (handle: FakeDbHandle): FakeDbHandle => ({
    ...handle,
    insert: (table) => ({
      values: (values) =>
        handle
          .insert(table)
          .values(
            table === schema.customBundles && !Array.isArray(values)
              ? { updatedAt: new Date(), ...values }
              : values,
          ),
    }),
    select: (fields) => ({
      from: (table) =>
        table === schema.customBundleItems
          ? (noRows() as never)
          : handle.select(fields).from(table),
    }),
    transaction: (fn) => handle.transaction((tx) => fn(answersBundles(tx))),
  });

  let dirs: string[] = [];
  const roots = { repo: process.env.REPO_STORAGE_ROOT, bundle: process.env.BUNDLE_STORAGE_ROOT };

  afterEach(async () => {
    for (const [name, value] of [
      ['REPO_STORAGE_ROOT', roots.repo],
      ['BUNDLE_STORAGE_ROOT', roots.bundle],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs = [];
  });

  /** Every table a request could write, the storage volumes it could write to, and what it queued. */
  async function jobFixture() {
    const storage = await mkdtemp(join(tmpdir(), 'new-work-jobs-'));
    dirs.push(storage);
    const repoRoot = join(storage, 'repos');
    const bundleRoot = join(storage, 'bundles');
    await mkdir(repoRoot);
    await mkdir(bundleRoot);
    process.env.REPO_STORAGE_ROOT = repoRoot;
    process.env.BUNDLE_STORAGE_ROOT = bundleRoot;
    const fake = createFakeDb(JOB_TABLES);
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      name: 'repo',
      source: 'git_https',
      remoteUrl: 'https://example.com/r.git',
      status: 'ready',
    });
    h.db = answersBundles(fake.db);
    h.dbCalls = 0;
    h.jobs = [];
    const written = async () => [
      Object.values(JOB_TABLES).map((table) => fake.rows(table)),
      (await readdir(storage, { recursive: true })).sort(),
      [...h.jobs],
    ];
    return { fake, repoRoot, bundleRoot, written };
  }
  type JobFixture = Awaited<ReturnType<typeof jobFixture>>;

  /** What the updater's live-work count reads, off the rows the routes wrote. */
  const inProgress = ({ fake }: JobFixture) =>
    fake.rows(schema.repositories).filter((r) => r.status === 'cloning').length +
    fake.rows(schema.customBundles).filter((r) => r.status === 'syncing').length +
    fake
      .rows(schema.cliProviders)
      .filter(
        (r) =>
          r.sandboxImageBuildStatus === 'building' || r.modelProvisionStatus === 'provisioning',
      ).length;

  const stage = async (root: string, name: string) => {
    const dir = join(root, '_uploads', USER);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), 'zip bytes');
    return join(dir, name);
  };
  const bundle = (
    { fake, bundleRoot }: JobFixture,
    over: Record<string, unknown>,
  ): Record<string, unknown> =>
    fake.insert(schema.customBundles, {
      id: JOB_BUNDLE,
      userId: USER,
      repositoryId: REPO,
      name: 'kit',
      storageRoot: join(bundleRoot, USER, JOB_BUNDLE, 'extracted'),
      status: 'active',
      updatedAt: new Date(),
      ...over,
    });
  const bundleUpload = async ({ fake, bundleRoot }: JobFixture, over: Record<string, unknown>) =>
    fake.insert(schema.customBundleUploads, {
      id: JOB_UPLOAD,
      userId: USER,
      repositoryId: REPO,
      name: 'kit',
      enabledKinds: ['agent', 'skill'],
      filename: 'kit.zip',
      archiveFormat: 'zip',
      totalSize: 9,
      bytesReceived: 9,
      chunkSize: 9,
      archivePath: await stage(bundleRoot, `${JOB_UPLOAD}.zip.partial`),
      status: 'uploading',
      ...over,
    });
  const provider = ({ fake }: JobFixture, over: Record<string, unknown> = {}) =>
    fake.insert(schema.cliProviders, {
      id: JOB_PROVIDER,
      userId: USER,
      name: 'claude-code',
      label: 'p',
      rulesContent: DEFAULT_AGENT_RULES,
      sandboxImageBuildStatus: 'idle',
      modelProvisionStatus: 'idle',
      ...over,
    });

  interface JobRoute {
    name: string;
    /** The rows and files the request needs in place. */
    prepare?: (fx: JobFixture) => Promise<unknown> | unknown;
    send: (app: Hono<AppEnv>) => Response | Promise<Response>;
    status: number;
    /** The queue jobs a request answered as usual adds. */
    jobs: string[];
    /** Refused by the route's first handler, before it reads anything. */
    early: boolean;
  }

  const JOB_ROUTES: JobRoute[] = [
    {
      name: 'POST /repositories',
      send: (app) =>
        app.request('/repositories', jsonRequest('POST', { source: 'blank', name: 'fresh' })),
      status: 201,
      jobs: [REPO_JOB_NAMES.INIT],
      early: true,
    },
    {
      name: 'POST /repositories/upload',
      send: (app) => {
        const form = new FormData();
        form.set('archive', new File([new Uint8Array(Buffer.from('PK\nan archive'))], 'a.zip'));
        return app.request('/repositories/upload', { method: 'POST', body: form });
      },
      status: 201,
      jobs: [REPO_JOB_NAMES.EXTRACT],
      early: true,
    },
    {
      name: 'POST /repositories/upload/:id/complete',
      prepare: async ({ fake, repoRoot }) =>
        fake.insert(schema.repoUploads, {
          id: JOB_UPLOAD,
          userId: USER,
          filename: 'a.zip',
          archiveFormat: 'zip',
          totalSize: 9,
          bytesReceived: 9,
          chunkSize: 9,
          archivePath: await stage(repoRoot, `${JOB_UPLOAD}.zip.partial`),
          status: 'uploading',
        }),
      send: (app) => app.request(`/repositories/upload/${JOB_UPLOAD}/complete`, { method: 'POST' }),
      status: 201,
      jobs: [REPO_JOB_NAMES.EXTRACT],
      early: true,
    },
    {
      name: 'POST /repositories/:id/refresh-tree',
      send: (app) => app.request(`/repositories/${REPO}/refresh-tree`, { method: 'POST' }),
      status: 200,
      jobs: [REPO_JOB_NAMES.REFRESH],
      early: true,
    },
    {
      name: 'POST /bundles',
      send: (app) =>
        app.request(
          '/bundles',
          jsonRequest('POST', {
            repositoryId: REPO,
            name: 'kit',
            gitUrl: 'https://example.com/kit.git',
            enabledKinds: ['agent', 'skill'],
          }),
        ),
      status: 201,
      jobs: [BUNDLE_JOB_NAMES.INGEST_GIT],
      early: true,
    },
    {
      name: 'POST /bundles/uploads/:id/complete',
      prepare: (fx) => bundleUpload(fx, {}),
      send: (app) => app.request(`/bundles/uploads/${JOB_UPLOAD}/complete`, { method: 'POST' }),
      status: 201,
      jobs: [BUNDLE_JOB_NAMES.INGEST_ZIP],
      early: true,
    },
    {
      name: 'POST /bundles/:id/replace/:uploadId/complete',
      prepare: async (fx) => {
        bundle(fx, { sourceType: 'zip', enabledKinds: ['agent', 'skill'] });
        await bundleUpload(fx, { bundleId: JOB_BUNDLE });
        const tree = join(fx.bundleRoot, USER, JOB_BUNDLE, 'extracted');
        await mkdir(tree, { recursive: true });
        await writeFile(join(tree, 'agent.md'), 'the current tree');
      },
      send: (app) =>
        app.request(`/bundles/${JOB_BUNDLE}/replace/${JOB_UPLOAD}/complete`, { method: 'POST' }),
      status: 200,
      jobs: [BUNDLE_JOB_NAMES.INGEST_ZIP],
      early: true,
    },
    {
      name: 'POST /bundles/:id/sync',
      prepare: (fx) =>
        bundle(fx, { sourceType: 'git', gitUrl: 'https://example.com/kit.git', gitBranch: 'main' }),
      send: (app) => app.request(`/bundles/${JOB_BUNDLE}/sync`, { method: 'POST' }),
      status: 200,
      jobs: [BUNDLE_JOB_NAMES.RESYNC_GIT],
      early: true,
    },
    {
      name: 'POST /cli-providers',
      send: (app) =>
        app.request(
          '/cli-providers',
          jsonRequest('POST', { name: 'claude-code', label: 'p', authMode: 'api_key' }),
        ),
      status: 201,
      jobs: [CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE],
      early: true,
    },
    {
      name: 'PATCH /cli-providers/:id, which changes what the sandbox image is built from',
      prepare: (fx) => provider(fx),
      send: (app) =>
        app.request(
          `/cli-providers/${JOB_PROVIDER}`,
          jsonRequest('PATCH', { sandboxDockerfileExtra: 'RUN true' }),
        ),
      status: 200,
      jobs: [CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE],
      early: false,
    },
    {
      name: 'PATCH /cli-providers/:id, which changes the model an ollama provider pulls',
      prepare: (fx) => provider(fx, { name: 'ollama', model: 'qwen3-coder:30b' }),
      send: (app) =>
        app.request(
          `/cli-providers/${JOB_PROVIDER}`,
          jsonRequest('PATCH', { model: 'llama3.1:8b' }),
        ),
      status: 200,
      jobs: [CLI_EXEC_JOB_NAMES.PROVISION_OLLAMA_MODEL],
      early: false,
    },
    {
      name: 'POST /cli-providers/:id/sandbox-image/build',
      prepare: (fx) => provider(fx),
      send: (app) =>
        app.request(`/cli-providers/${JOB_PROVIDER}/sandbox-image/build`, { method: 'POST' }),
      status: 202,
      jobs: [CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE],
      early: true,
    },
    {
      name: 'POST /cli-providers/:id/clone',
      prepare: (fx) => provider(fx),
      send: (app) => app.request(`/cli-providers/${JOB_PROVIDER}/clone`, { method: 'POST' }),
      status: 201,
      jobs: [CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE],
      early: true,
    },
  ];

  const start = async (route: JobRoute) => {
    const fx = await jobFixture();
    await route.prepare?.(fx);
    return fx;
  };

  describe.each(JOB_ROUTES)('$name', (route) => {
    it('starts the job and leaves the in-progress row the drain counts while the system is normal', async () => {
      const fx = await start(route);
      expect(inProgress(fx)).toBe(0);

      const res = await route.send(jobs);

      expect(res.status).toBe(route.status);
      expect(h.jobs).toEqual(route.jobs);
      expect(inProgress(fx)).toBeGreaterThan(0);
    });

    it('has written the in-progress row by the time the transaction that admits the job commits', async () => {
      const fx = await start(route);
      const atCommit: number[] = [];
      fx.fake.hooks.beforeCommit = () => {
        atCommit.push(inProgress(fx));
      };

      await route.send(jobs);

      expect(atCommit[0]).toBeGreaterThan(0);
    });

    it.each(['draining', 'maintenance'])(
      'answers 503 and writes and queues nothing while the system is %s',
      async (state) => {
        const fx = await start(route);
        const before = await fx.written();
        h.state = state;

        const res = await route.send(jobs);

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: REFUSAL, code: null });
        expect(await fx.written()).toEqual(before);
        if (route.early) expect(h.dbCalls).toBe(0);
      },
    );

    it('answers 503 and writes and queues nothing when the state turns draining after the early check', async () => {
      const fx = await start(route);
      const before = await fx.written();
      const stored = turnsDrainingAfterTheEarlyCheck();

      const res = await route.send(jobs);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(await fx.written()).toEqual(before);
      expect(stored).toHaveBeenCalledTimes(2);
    });

    describe('behind the real maintenance gate', () => {
      it('starts the job when the cached copy and the stored state both say normal', async () => {
        await start(route);
        states('normal', 'normal');

        const res = await route.send(gatedJobs);

        expect(res.status).toBe(route.status);
        expect(h.jobs).toEqual(route.jobs);
      });

      it.each(['draining', 'maintenance'])(
        'answers 503 and writes and queues nothing when only the stored state is %s, the cached copy still saying normal',
        async (stored) => {
          const fx = await start(route);
          const before = await fx.written();
          states('normal', stored);

          const res = await route.send(gatedJobs);

          expect(res.status).toBe(503);
          expect(await res.json()).toEqual({ error: REFUSAL, code: null });
          expect(await fx.written()).toEqual(before);
        },
      );
    });
  });

  describe('POST /bundles/uploads/:id/complete repeated after the job it queued was lost', () => {
    const lost = async () => {
      const fx = await jobFixture();
      bundle(fx, { id: JOB_UPLOAD, sourceType: 'zip', status: 'failed' });
      await bundleUpload(fx, { bundleId: JOB_UPLOAD });
      await rm(join(fx.bundleRoot, '_uploads'), { recursive: true });
      const final = join(fx.bundleRoot, USER, JOB_UPLOAD);
      await mkdir(final, { recursive: true });
      await writeFile(join(final, 'source.zip'), 'zip bytes');
      return fx;
    };
    const repeat = () =>
      jobs.request(`/bundles/uploads/${JOB_UPLOAD}/complete`, { method: 'POST' });

    it('queues the bundle again while the system is normal', async () => {
      const fx = await lost();

      expect((await repeat()).status).toBe(201);
      expect(fx.fake.rows(schema.customBundles)[0]).toMatchObject({ status: 'syncing' });
      expect(h.jobs).toEqual([BUNDLE_JOB_NAMES.INGEST_ZIP]);
    });

    it('answers 503 and leaves the bundle failed when the state turns draining after the first transaction', async () => {
      const fx = await lost();
      h.state = 'draining';
      const stored = vi
        .spyOn(configService, 'getFresh')
        .mockClear()
        .mockResolvedValueOnce('normal')
        .mockResolvedValueOnce('normal');

      const res = await repeat();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: REFUSAL, code: null });
      expect(fx.fake.rows(schema.customBundles)[0]).toMatchObject({ status: 'failed' });
      expect(h.jobs).toEqual([]);
      expect(stored).toHaveBeenCalledTimes(3);
    });
  });

  describe('PATCH /cli-providers/:id while the system drains', () => {
    beforeEach(() => {
      h.state = 'draining';
    });
    const patch = (body: unknown) =>
      jobs.request(`/cli-providers/${JOB_PROVIDER}`, jsonRequest('PATCH', body));

    it('still saves an edit that starts no job', async () => {
      const fx = await jobFixture();
      provider(fx);

      expect((await patch({ label: 'renamed' })).status).toBe(200);
      expect(fx.fake.rows(schema.cliProviders)[0]).toMatchObject({ label: 'renamed' });
      expect(h.jobs).toEqual([]);
    });

    it('still saves a model change that provisions nothing', async () => {
      const fx = await jobFixture();
      provider(fx, { model: 'sonnet' });

      expect((await patch({ model: 'opus' })).status).toBe(200);
      expect(fx.fake.rows(schema.cliProviders)[0]).toMatchObject({ model: 'opus' });
      expect(h.jobs).toEqual([]);
    });
  });

  describe('the code that starts such a job', () => {
    const STARTS =
      /\bgetRepoQueue\(|\bgetBundleQueue\(|CLI_EXEC_JOB_NAMES\.(BUILD_SANDBOX_IMAGE|PROVISION_OLLAMA_MODEL)\b/g;
    const src = join(import.meta.dirname, '../src');
    const starters = () =>
      readdirSync(src, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts') && file !== 'queues.ts')
        .map((file) => ({ file, text: readFileSync(join(src, file), 'utf8') }))
        .map(({ file, text }) => ({ file, starts: text.match(STARTS)?.length ?? 0, text }))
        .filter(({ starts }) => starts > 0)
        .sort((a, b) => a.file.localeCompare(b.file));

    it('sits only in files whose routes are gated and listed above, at the sites counted here', () => {
      expect(
        Object.fromEntries(starters().map(({ file, starts }) => [file, starts])),
        'a file starts a job: gate its routes with requireNewWorkAllowed and admitNewWork, add them to JOB_ROUTES, and count the site here',
      ).toEqual({ 'routes/bundles.ts': 4, 'routes/cli-providers.ts': 3, 'routes/repos.ts': 4 });
    });

    it('takes the new-work fence in every file that starts one', () => {
      const unfenced = starters()
        .filter(
          ({ text }) =>
            !/\badmitNewWork\(/.test(text) ||
            !/\b(requireNewWorkAllowed|assertNewWorkAllowed)\b/.test(text),
        )
        .map(({ file }) => file);

      expect(
        unfenced,
        'a file that starts a job must call assertNewWorkAllowed early and admitNewWork in the transaction that writes the in-progress status',
      ).toEqual([]);
    });
  });
});
