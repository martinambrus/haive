import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  definitions: [] as { slug: string; displayName: string }[],
}));

function stubDb() {
  const chain = (table: unknown, fields: Record<string, unknown> | undefined) => {
    const q: Record<string, unknown> = {};
    for (const m of ['where', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin', 'groupBy']) {
      q[m] = () => q;
    }
    q.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
      const rows =
        table === schemaRef.taskTypeDefinitions
          ? h.definitions
          : fields && 'n' in fields
            ? [{ n: h.tasks.length }]
            : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return q;
  };
  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => chain(table, fields),
    }),
    selectDistinct: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => chain(table, fields),
    }),
    query: {
      tasks: {
        findMany: async (opts: { where?: unknown }) => (opts.where ? h.tasks : []),
        findFirst: async () => h.tasks[0],
      },
    },
  };
}

const schemaRef = vi.hoisted(() => ({}) as { taskTypeDefinitions: unknown });

vi.mock('../src/db.js', () => ({ getDb: () => stubDb() }));
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
  sumTaskTokens: async () => new Map(),
  resolveCurrentStepCliProviderIds: async () => new Map(),
  enrichStepsWithCliPreferences: async (_db: unknown, _u: unknown, rows: unknown[]) => rows,
  enrichStepsWithSkipFlag: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithCliStats: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithActiveRole: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithAgentCounts: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithCliUsage: (rows: unknown[]) => rows,
  findActiveCliInvocation: async () => null,
  sumTaskProviderBreakdown: async () => [],
  buildUpcomingCliSteps: async () => [],
}));
vi.mock('../src/routes/tasks/_call-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/tasks/_call-log.js')>()),
  loadLoggedCallCount: async () => 0,
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

schemaRef.taskTypeDefinitions = schema.taskTypeDefinitions;

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

function taskRow(id: string, type: string) {
  return {
    id,
    userId: USER,
    type,
    title: id,
    status: 'running',
    currentStepId: null,
    currentRound: 0,
    pausedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(0),
    parentTaskId: null,
    ignoreSavedStepClis: false,
    awaitingAllowanceProviderId: null,
    awaitingProviderReason: null,
    allowanceReplenishedAt: null,
    allowanceAutoResumedAt: null,
  };
}

beforeEach(() => {
  h.tasks = [
    taskRow('custom', 'acme_audit'),
    taskRow('renamed', 'workflow'),
    taskRow('orphan', 'ghost_type'),
  ];
  h.definitions = [
    { slug: 'acme_audit', displayName: 'Acme audit' },
    { slug: 'workflow', displayName: 'Feature delivery' },
    { slug: 'plan_merge', displayName: 'Plan merge' },
  ];
});

describe('task type labels', () => {
  it('the list carries each task type label from task_type_definitions', async () => {
    const res = await app.request('/tasks?includeChats=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string; typeLabel: string | null }[] };
    expect(Object.fromEntries(body.tasks.map((t) => [t.id, t.typeLabel]))).toEqual({
      custom: 'Acme audit',
      renamed: 'Feature delivery',
      orphan: null,
    });
  });

  it.each([
    ['custom', 'Acme audit'],
    ['renamed', 'Feature delivery'],
    ['orphan', null],
  ])('the detail of %s carries typeLabel %s', async (id, label) => {
    h.tasks = h.tasks.filter((t) => t.id === id);
    const res = await app.request(`/tasks/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { typeLabel: string | null } };
    expect(body.task.typeLabel).toBe(label);
  });
});
