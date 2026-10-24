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
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const REPO = '00000000-0000-4000-8000-0000000000b1';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

type Rows = Record<string, unknown>;
type Relation = { columns?: Rows };

/** The fake has no relations: the repository relation is resolved the way Drizzle would, columns included. */
function routeDb(db: FakeDbHandle) {
  const tasks = db.query.tasks!;
  const repositories = db.query.repositories!;
  const resolve = async (opts: Rows = {}) => {
    const { with: relations, ...rest } = opts;
    const row = (await tasks.findFirst(rest)) as Rows | undefined;
    const repository = (relations as { repository?: Relation } | undefined)?.repository;
    if (!row || !repository || !row.repositoryId) return row;
    return {
      ...row,
      repository:
        (await repositories.findFirst({
          where: eq(schema.repositories.id, row.repositoryId as string),
          columns: repository.columns,
        })) ?? null,
    };
  };
  return {
    ...db,
    query: {
      ...db.query,
      tasks: {
        findFirst: resolve,
        findMany: (opts: Rows = {}) => {
          const { with: _relations, ...rest } = opts;
          return tasks.findMany(rest);
        },
      },
    },
  };
}

function setup(repo: Rows) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    modules: schema.modules,
    stepCatalog: schema.stepCatalog,
    taskTypeDefinitions: schema.taskTypeDefinitions,
    repositories: schema.repositories,
    cliProviders: schema.cliProviders,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'Local',
    source: 'local_path',
    localPath: '/host/secret/project',
    ...repo,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'workflow',
    title: 'a task',
    status: 'running',
    currentRound: 0,
    orchestrationEpoch: 3,
  });
  h.db = routeDb(fake.db);
}

async function repositoryOf(): Promise<unknown> {
  const res = await app.request(`/${TASK}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { task: { repository: unknown } }).task.repository;
}

describe('GET /tasks/:id repository', () => {
  it('A1 names a read-only local repository by the fields the attachments tab needs, and no more', async () => {
    setup({ writable: false });
    expect(await repositoryOf()).toEqual({
      id: REPO,
      name: 'Local',
      source: 'local_path',
      writable: false,
    });
  });

  it('A2 reports a writable local repository as writable', async () => {
    setup({ writable: true });
    expect(await repositoryOf()).toEqual({
      id: REPO,
      name: 'Local',
      source: 'local_path',
      writable: true,
    });
  });
});
