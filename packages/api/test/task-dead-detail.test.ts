import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...actual,
    configService: {
      ...actual.configService,
      get: async () => 'USD',
      getBoolean: async () => false,
    },
  };
});
vi.mock('@haive/shared/stats-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/stats-server')>()),
  resolveCostDisplay: async () => ({ currency: 'USD', rate: 1 }),
}));
vi.mock('../src/routes/tasks/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/tasks/_helpers.js')>()),
  findQueuedInvocationStepIds: async () => new Set<string>(),
  enrichStepsWithCliPreferences: async (_db: unknown, _f: unknown, _u: unknown, rows: unknown[]) =>
    rows,
  enrichStepsWithSkipFlag: async (_db: unknown, _f: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithCliStats: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithActiveRole: async (_db: unknown, _f: unknown, _id: unknown, rows: unknown[]) =>
    rows,
  enrichStepsWithAgentCounts: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithCliUsage: (_flags: unknown, rows: unknown[]) => rows,
  findActiveCliInvocation: async () => null,
  loadFinishedRunsRevision: async () => '',
  sumTaskProviderBreakdown: async () => [],
  buildUpcomingCliSteps: async () => [],
}));
vi.mock('../src/routes/tasks/_call-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/tasks/_call-log.js')>()),
  loadLoggedCallCount: async () => ({ logged: 0, running: 0 }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const OTHER_TASK = '00000000-0000-4000-8000-000000000002';
const DEAD_AT = new Date('2026-10-14T09:00:00.000Z');

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

type Rows = Record<string, unknown>;
interface Detail {
  task: { deadAt: string | null };
  dead: {
    at: string;
    steps: {
      stepId: string;
      module: { id: string; name: string | null; missing: boolean } | null;
    }[];
  } | null;
}

const deadEvent = (unresolved: unknown, extra: Rows = {}): Rows => ({
  taskId: TASK,
  eventType: 'task.dead',
  payload: { reason: 'copy', unresolved, stepId: null, round: null, epoch: 3 },
  ...extra,
});

const moduleRow = (
  moduleId: string,
  name: string,
  missingAt: Date | null = new Date('2026-10-13T00:00:00.000Z'),
): Rows => ({
  moduleId,
  packageName: `@acme/haive-module-${moduleId}`,
  name,
  installedVersion: '1.0.0',
  missingAt,
});

/** The fake has no relations, so the `with` option is dropped; the route reads the task row. */
function routeDb(db: FakeDbHandle) {
  const plain = (opts: Rows = {}) => {
    const { with: _relations, ...rest } = opts;
    return rest;
  };
  const tasks = db.query.tasks!;
  return {
    ...db,
    query: {
      ...db.query,
      tasks: {
        findFirst: (opts?: Rows) => tasks.findFirst(plain(opts)),
        findMany: (opts?: Rows) => tasks.findMany(plain(opts)),
      },
    },
  };
}

function setup(task: Rows, events: Rows[] = [], modules: Rows[] = []) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    modules: schema.modules,
    stepCatalog: schema.stepCatalog,
    taskTypeDefinitions: schema.taskTypeDefinitions,
    cliProviders: schema.cliProviders,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    type: 'workflow',
    title: 'a task',
    status: 'running',
    currentRound: 0,
    orchestrationEpoch: 3,
    deadAt: DEAD_AT,
    deadReason: 'the run list names a step this install does not register',
    ...task,
  });
  for (const event of events) fake.insert(schema.taskEvents, event);
  for (const row of modules) fake.insert(schema.modules, row);
  h.db = routeDb(fake.db);
}

async function detail(): Promise<Detail> {
  const res = await app.request(`/${TASK}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
}

describe('GET /tasks/:id on a dead task', () => {
  it('names the module that provided a step the install no longer has', async () => {
    setup({}, [deadEvent(['module.acme.review'])], [moduleRow('acme', 'Acme Review')]);
    const body = await detail();
    expect(body.dead).toEqual({
      at: DEAD_AT.toISOString(),
      steps: [
        {
          stepId: 'module.acme.review',
          module: { id: 'acme', name: 'Acme Review', missing: true },
        },
      ],
    });
    expect(body.task.deadAt).toBe(DEAD_AT.toISOString());
  });

  it('gives the module id with no name when its row is gone', async () => {
    setup({}, [deadEvent(['module.acme.review'])]);
    expect((await detail()).dead?.steps).toEqual([
      { stepId: 'module.acme.review', module: { id: 'acme', name: null, missing: true } },
    ]);
  });

  it('tells an installed module that no longer provides the step from a missing one', async () => {
    setup({}, [deadEvent(['module.acme.review'])], [moduleRow('acme', 'Acme Review', null)]);
    expect((await detail()).dead?.steps).toEqual([
      {
        stepId: 'module.acme.review',
        module: { id: 'acme', name: 'Acme Review', missing: false },
      },
    ]);
  });

  it('gives no module for a core step or a pinned prompt step', async () => {
    setup({}, [deadEvent(['07-phase-2-implement', 'custom.audit.pass'])]);
    expect((await detail()).dead?.steps).toEqual([
      { stepId: '07-phase-2-implement', module: null },
      { stepId: 'custom.audit.pass', module: null },
    ]);
  });

  it('keeps the order of the worker list and resolves each module on its own', async () => {
    setup(
      {},
      [deadEvent(['module.ghost.x', '07-phase-2-implement', 'module.acme.review'])],
      [moduleRow('acme', 'Acme Review'), moduleRow('other', 'Not Named')],
    );
    expect((await detail()).dead?.steps).toEqual([
      { stepId: 'module.ghost.x', module: { id: 'ghost', name: null, missing: true } },
      { stepId: '07-phase-2-implement', module: null },
      {
        stepId: 'module.acme.review',
        module: { id: 'acme', name: 'Acme Review', missing: true },
      },
    ]);
  });

  it('reads the latest task.dead event of this task and only that', async () => {
    setup({}, [
      deadEvent(['module.old.step'], { createdAt: new Date('2026-10-14T08:00:00.000Z') }),
      deadEvent(['module.acme.review'], { createdAt: new Date('2026-10-14T09:00:00.000Z') }),
      deadEvent(['module.later.step'], {
        taskId: OTHER_TASK,
        createdAt: new Date('2026-10-14T10:00:00.000Z'),
      }),
      {
        ...deadEvent(['module.revived.step']),
        eventType: 'task.revived',
        createdAt: new Date('2026-10-14T11:00:00.000Z'),
      },
    ]);
    expect((await detail()).dead?.steps).toEqual([
      { stepId: 'module.acme.review', module: { id: 'acme', name: null, missing: true } },
    ]);
  });

  it('takes the steps from the event and never from the dead_reason copy', async () => {
    setup(
      { deadReason: 'the run list names a step this install does not register: module.copy.only' },
      [deadEvent(['module.acme.review'])],
    );
    expect((await detail()).dead?.steps.map((s) => s.stepId)).toEqual(['module.acme.review']);
  });

  it.each([
    ['no task.dead event', []],
    ['a list that is not an array', [deadEvent('module.acme.review')]],
  ])('is still dead, with no steps, on %s', async (_name, events) => {
    setup({}, events);
    expect((await detail()).dead).toEqual({ at: DEAD_AT.toISOString(), steps: [] });
  });

  it('keeps the step ids of a list and drops anything in it that is not one', async () => {
    setup({}, [deadEvent([7, null, '07-phase-2-implement'])]);
    expect((await detail()).dead?.steps).toEqual([
      { stepId: '07-phase-2-implement', module: null },
    ]);
  });
});

describe('GET /tasks/:id on a task that is not dead', () => {
  it('has no dead detail, whatever event the task once wrote', async () => {
    setup({ deadAt: null, deadReason: null }, [deadEvent(['module.acme.review'])]);
    expect((await detail()).dead).toBeNull();
  });

  it('has no dead detail on a dead_reason with no dead_at', async () => {
    setup({ deadAt: null }, [deadEvent(['module.acme.review'])]);
    expect((await detail()).dead).toBeNull();
  });

  it.each(['cancelled', 'completed'])(
    'has no dead detail on a %s task that kept its dead_at',
    async (status) => {
      setup({ status }, [deadEvent(['module.acme.review'])]);
      const body = await detail();
      expect(body.dead).toBeNull();
      expect(body.task.deadAt).toBe(DEAD_AT.toISOString());
    },
  );
});
