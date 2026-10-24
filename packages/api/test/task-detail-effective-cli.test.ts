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
const OWN = '00000000-0000-4000-8000-0000000000c2';
const OLDEST = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

type Rows = Record<string, unknown>;

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

function setup(cliProviderId: string | null, providers: Rows[] | null) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    modules: schema.modules,
    stepCatalog: schema.stepCatalog,
    taskTypeDefinitions: schema.taskTypeDefinitions,
    ...(providers ? { cliProviders: schema.cliProviders } : {}),
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    type: 'workflow',
    title: 'a task',
    status: 'running',
    currentRound: 0,
    orchestrationEpoch: 3,
    cliProviderId,
  });
  for (const p of providers ?? []) fake.insert(schema.cliProviders, { name: 'codex', ...p });
  h.db = routeDb(fake.db);
}

async function effective(): Promise<string | null | undefined> {
  const res = await app.request(`/${TASK}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { task: { effectiveCliProviderId?: string | null } }).task
    .effectiveCliProviderId;
}

const provider = (id: string, day: number, enabled = true): Rows => ({
  id,
  userId: USER,
  enabled,
  createdAt: new Date(Date.UTC(2026, 0, day)),
});

describe('GET /tasks/:id effectiveCliProviderId', () => {
  it('is the default provider for a task with no CLI of its own', async () => {
    setup(null, [provider(OWN, 2), provider(OLDEST, 1)]);
    expect(await effective()).toBe(OLDEST);
  });

  it("is the task's own CLI, with no provider read needed", async () => {
    setup(OWN, null);
    expect(await effective()).toBe(OWN);
  });

  it('is null when a task with no CLI has no enabled provider to default to', async () => {
    setup(null, [provider(OLDEST, 1, false)]);
    expect(await effective()).toBeNull();
  });
});
