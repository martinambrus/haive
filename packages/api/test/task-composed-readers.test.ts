import { expect, it, vi } from 'vitest';

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
  enrichStepsWithSkipFlag: async (_db: unknown, _f: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithCliStats: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithActiveRole: async (_db: unknown, _f: unknown, _id: unknown, rows: unknown[]) =>
    rows,
  enrichStepsWithAgentCounts: async (_db: unknown, _id: unknown, rows: unknown[]) => rows,
  enrichStepsWithCliUsage: (_flags: unknown, rows: unknown[]) => rows,
  findActiveCliInvocation: async () => null,
  loadFinishedRunsRevision: async () => '',
  sumTaskProviderBreakdown: async () => [],
  sumTaskTokens: async () => new Map(),
  buildUpcomingCliSteps: async () => [],
}));
vi.mock('../src/routes/tasks/_call-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/tasks/_call-log.js')>()),
  loadLoggedCallCount: async () => ({ logged: 0, running: 0 }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import { staticStepFlags } from './step-flags-fixture.js';
import { providerDisableImpact } from '../src/lib/provider-disable-impact.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

vi.mock('../src/lib/step-flags.js', async (original) => ({
  ...(await original<object>()),
  loadStepFlags: async () => staticStepFlags(),
  loadTaskStepFlags: async () => staticStepFlags(),
}));

const TASK = '00000000-0000-4000-8000-000000000001';
const BAD = '00000000-0000-4000-8000-000000000002';
const CLAUDE = '00000000-0000-4000-8000-0000000000c1';
const CODEX = '00000000-0000-4000-8000-0000000000c2';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const STEP = '08c-code-review';
const SECRET = 'metadata-must-not-be-logged';
const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.onError(errorHandler);

function setup() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskCheckRuns: schema.taskCheckRuns,
    taskEvents: schema.taskEvents,
    modules: schema.modules,
    repositories: schema.repositories,
    stepCatalog: schema.stepCatalog,
    taskTypeDefinitions: schema.taskTypeDefinitions,
    cliProviders: schema.cliProviders,
    envTemplates: schema.envTemplates,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
  });
  fake.insert(schema.envTemplates, {
    id: TEMPLATE,
    declaredDeps: { lspInstallContractVersion: 2 },
  });
  for (const [id, name] of [
    [CLAUDE, 'claude-code'],
    [CODEX, 'codex'],
  ])
    fake.insert(schema.cliProviders, {
      id,
      name,
      userId: USER,
      enabled: true,
      createdAt: new Date(1),
    });
  for (const id of [BAD, TASK]) {
    fake.insert(schema.tasks, {
      id,
      userId: USER,
      type: 'reader-test',
      title: id,
      status: 'running',
      currentRound: 0,
      currentStepId: STEP,
      cliProviderId: CLAUDE,
      envTemplateId: TEMPLATE,
      ignoreSavedStepClis: false,
      runListSnapshot: [STEP],
      metadata: id === BAD ? { composedLspImageRefs: { schemaVersion: SECRET } } : null,
    });
    fake.insert(schema.taskSteps, { taskId: id, stepId: STEP, status: 'pending', round: 0 });
  }
  fake.insert(schema.userStepCliPreferences, {
    userId: USER,
    stepId: STEP,
    cliProviderId: CODEX,
    explicit: true,
  });
  const tasks = fake.db.query.tasks!;
  const plain = (opts: Record<string, unknown> = {}) => {
    const { with: _relations, ...rest } = opts;
    return rest;
  };
  h.db = {
    ...fake.db,
    // The fake DB does not evaluate aggregate SQL or joins; listing plumbing only.
    select: (fields?: Record<string, unknown>) =>
      fields && 'n' in fields
        ? { from: () => ({ where: async () => [{ n: 2 }] }) }
        : fake.db.select(fields as never),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ orderBy: async () => [] }),
        }),
      }),
    }),
    query: {
      ...fake.db.query,
      tasks: {
        findFirst: (opts?: Record<string, unknown>) => tasks.findFirst(plain(opts)),
        findMany: (opts?: Record<string, unknown>) => tasks.findMany(plain(opts)),
      },
    },
  };
  return fake;
}

it('lists a malformed composed task with the raw view and still substitutes other tasks', async () => {
  setup();
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    const res = await app.request('/?sort=updated');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: { id: string; currentStepCliProviderIds: string[] }[];
    };
    expect(body.tasks.find((t) => t.id === TASK)?.currentStepCliProviderIds).toEqual([CLAUDE]);
    expect(body.tasks.find((t) => t.id === BAD)?.currentStepCliProviderIds).toEqual([CODEX]);
    expect(warn).toHaveBeenCalledWith({ taskId: BAD }, expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  } finally {
    warn.mockRestore();
  }
});

it.each(['', '/steps'])('opens a malformed composed task on /:id%s', async (suffix) => {
  setup();
  const res = await app.request(`/${BAD}${suffix}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    steps: { preferredCliProviderId: string; effectiveCliProviderIds?: string[] }[];
  };
  expect(body.steps[0]?.preferredCliProviderId).toBe(CODEX);
  expect(body.steps[0]).not.toHaveProperty('effectiveCliProviderIds');
});

it('keeps the disable preview available and counts the malformed task using its raw preference', async () => {
  const fake = setup();
  expect(await providerDisableImpact(fake.db as never, USER, CODEX)).toEqual({
    taskCount: 1,
    stepCount: 1,
  });
  expect(await providerDisableImpact(fake.db as never, USER, CLAUDE)).toEqual({
    taskCount: 1,
    stepCount: 1,
  });
});
