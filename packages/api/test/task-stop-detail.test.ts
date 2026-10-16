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
const FAILED_AT = new Date('2026-10-15T09:00:00.000Z');
const AFTER_FAILURE = new Date('2026-10-15T09:00:01.000Z');
const BEFORE_FAILURE = new Date('2026-10-15T08:59:00.000Z');
const MODULE_STOP = {
  by: 'admin-1',
  byAdmin: true,
  reason: 'module_deactivated',
  moduleId: 'alpha',
  killed: 1,
  cancelled: 1,
  stopped: 1,
};

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

type Rows = Record<string, unknown>;
interface Detail {
  stop: { reason: string; moduleId: string | null } | null;
}

const stopEvent = (payload: unknown, createdAt = AFTER_FAILURE, extra: Rows = {}): Rows => ({
  taskId: TASK,
  eventType: 'task.stopped',
  payload,
  createdAt,
  ...extra,
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

function setup(task: Rows, events: Rows[] = []) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    modules: schema.modules,
    stepCatalog: schema.stepCatalog,
    taskTypeDefinitions: schema.taskTypeDefinitions,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    type: 'workflow',
    title: 'a task',
    status: 'failed',
    errorMessage: 'Stopped by an administrator',
    completedAt: FAILED_AT,
    currentRound: 0,
    orchestrationEpoch: 3,
    ...task,
  });
  for (const event of events) fake.insert(schema.taskEvents, event);
  h.db = routeDb(fake.db);
}

async function stopOf(): Promise<Detail['stop']> {
  const res = await app.request(`/${TASK}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as Detail).stop;
}

describe('GET /tasks/:id on a task an administrator stopped', () => {
  it('names the reason and the module of the latest stop of a failed task', async () => {
    setup({}, [stopEvent(MODULE_STOP)]);
    expect(await stopOf()).toEqual({ reason: 'module_deactivated', moduleId: 'alpha' });
  });

  it.each(['created', 'queued', 'running', 'waiting_user', 'completed', 'cancelled'])(
    'has no stop on a %s task, whatever stop it once had',
    async (status) => {
      setup({ status }, [stopEvent(MODULE_STOP)]);
      expect(await stopOf()).toBeNull();
    },
  );

  it('has no stop on a failed task nothing stopped', async () => {
    setup({}, [
      stopEvent({ reason: 'module_deactivated' }, AFTER_FAILURE, { eventType: 'task.revived' }),
      stopEvent(MODULE_STOP, AFTER_FAILURE, { eventType: 'task.paused' }),
    ]);
    expect(await stopOf()).toBeNull();
  });

  it('reads the latest task.stopped event of this task and only that, whatever its reason', async () => {
    setup({}, [
      stopEvent(MODULE_STOP, new Date('2026-10-15T09:00:01.000Z')),
      stopEvent(
        { by: 'admin-1', byAdmin: true, reason: 'maintenance' },
        new Date('2026-10-15T09:00:05.000Z'),
      ),
      stopEvent(MODULE_STOP, new Date('2026-10-15T09:00:09.000Z'), { taskId: OTHER_TASK }),
    ]);
    expect(await stopOf()).toEqual({ reason: 'maintenance', moduleId: null });
  });

  it('has no stop once the task failed again after it: stopped, retried, failed for another reason', async () => {
    // NEGATIVE CONTROL: without the comparison this task reads as stopped by the module.
    setup({ errorMessage: 'It broke', completedAt: AFTER_FAILURE }, [
      stopEvent(MODULE_STOP, BEFORE_FAILURE),
    ]);
    expect(await stopOf()).toBeNull();
  });

  it('keeps a stop recorded in the very instant the task failed', async () => {
    setup({}, [stopEvent(MODULE_STOP, FAILED_AT)]);
    expect(await stopOf()).toEqual({ reason: 'module_deactivated', moduleId: 'alpha' });
  });

  it('keeps the stop of a failed task that carries no completion stamp', async () => {
    setup({ completedAt: null }, [stopEvent(MODULE_STOP, BEFORE_FAILURE)]);
    expect(await stopOf()).toEqual({ reason: 'module_deactivated', moduleId: 'alpha' });
  });

  describe('an event that carries the instant its stop failed the task', () => {
    const failedAtEvent = (failedAt: unknown, createdAt: Date) =>
      stopEvent({ ...MODULE_STOP, failedAt }, createdAt);

    it.each([
      ['after', AFTER_FAILURE],
      ['before', BEFORE_FAILURE],
    ])(
      'names the stop whose failedAt is the stamp the task failed with, recorded %s it',
      async (_when, createdAt) => {
        setup({}, [failedAtEvent(FAILED_AT.toISOString(), createdAt)]);
        expect(await stopOf()).toEqual({ reason: 'module_deactivated', moduleId: 'alpha' });
      },
    );

    it('names the stop that failed the task when a later stop of the failed task changed nothing', async () => {
      setup({}, [
        failedAtEvent(FAILED_AT.toISOString(), AFTER_FAILURE),
        stopEvent(
          { by: 'admin-1', byAdmin: true, reason: 'maintenance', failedAt: null },
          new Date('2026-10-15T09:00:05.000Z'),
        ),
      ]);
      expect(await stopOf()).toEqual({ reason: 'module_deactivated', moduleId: 'alpha' });
    });

    it('has no stop when a retry failed in between, though the event was recorded after that failure', async () => {
      setup({ errorMessage: 'It broke', completedAt: AFTER_FAILURE }, [
        failedAtEvent(FAILED_AT.toISOString(), new Date('2026-10-15T09:00:02.000Z')),
      ]);
      expect(await stopOf()).toBeNull();
    });

    it.each([
      ['a stop that did not fail the task', null, FAILED_AT],
      ['a failure that carries no completion stamp', FAILED_AT.toISOString(), null],
      ['a failedAt that is not a date', 'yesterday', FAILED_AT],
    ])('has no stop for %s', async (_name, failedAt, completedAt) => {
      setup({ completedAt }, [failedAtEvent(failedAt, AFTER_FAILURE)]);
      expect(await stopOf()).toBeNull();
    });
  });

  it('never reads the error text of the task', async () => {
    setup({ errorMessage: 'Halted by an operator' }, [stopEvent(MODULE_STOP)]);
    expect(await stopOf()).toEqual({ reason: 'module_deactivated', moduleId: 'alpha' });
    setup({ errorMessage: 'Stopped by an administrator' }, []);
    expect(await stopOf()).toBeNull();
  });

  it.each([
    ['no payload', null],
    ['an empty payload', {}],
    ['a reason that is not text', { reason: 5, moduleId: 'alpha' }],
    ['a module and no reason', { moduleId: 'alpha' }],
  ])('has no stop on an event with %s', async (_name, payload) => {
    setup({}, [stopEvent(payload)]);
    expect(await stopOf()).toBeNull();
  });

  it('drops a module id that is not text, and never passes on who stopped the task', async () => {
    setup({}, [stopEvent({ ...MODULE_STOP, moduleId: 7 })]);
    const stop = await stopOf();
    expect(stop).toEqual({ reason: 'module_deactivated', moduleId: null });
    expect(JSON.stringify(stop)).not.toContain('admin-1');
  });
});
