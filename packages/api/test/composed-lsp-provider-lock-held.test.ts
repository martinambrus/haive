import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: vi.fn(async () => 0) }));

import { Hono } from 'hono';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { writeStepCliChoice } from '../src/lib/step-cli-choice.js';
import type { AppEnv } from '../src/context.js';
import { seedStepCatalog } from './step-flags-fixture.js';

/**
 * Every writer of a task's CLI choice must hold the task row's lock at the moment it writes, so
 * that a step-01 writer that links the task to a contract-2 template (which takes the same lock)
 * and the CLI change cannot both pass their check and then both write. Each pin samples the lock
 * inside the write itself and requires at least one write to have been seen.
 */

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const CLAUDE_A = '00000000-0000-4000-8000-0000000000b1';
const CODEX = '00000000-0000-4000-8000-0000000000b2';
const STEP_ROW = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.route('/', taskRoutes);
app.onError(errorHandler);

/** A running task on claude row A with a template that has no contract, so every write happens. */
function setup() {
  const fake = createFakeDb(
    {
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskEvents: schema.taskEvents,
      cliProviders: schema.cliProviders,
      cliInvocations: schema.cliInvocations,
      taskStepAgentMinings: schema.taskStepAgentMinings,
      taskStepCliChoices: schema.taskStepCliChoices,
      userStepCliPreferences: schema.userStepCliPreferences,
      userStepCliRolePreferences: schema.userStepCliRolePreferences,
      stepCatalog: schema.stepCatalog,
      envTemplates: schema.envTemplates,
    },
    { rowLocks: true },
  );
  seedStepCatalog(fake);
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status: 'running',
    orchestrationEpoch: 1,
    cliProviderId: CLAUDE_A,
    envTemplateId: TEMPLATE,
  });
  fake.insert(schema.envTemplates, {
    id: TEMPLATE,
    userId: USER,
    name: 't',
    baseImage: 'img',
    declaredDeps: {},
  });
  fake.insert(schema.cliProviders, {
    id: CLAUDE_A,
    userId: USER,
    name: 'claude-code',
    enabled: true,
    createdAt: new Date(1),
  });
  fake.insert(schema.cliProviders, {
    id: CODEX,
    userId: USER,
    name: 'codex',
    enabled: true,
    createdAt: new Date(2),
  });
  h.db = fake.db;
  return fake;
}

/** Records, per table written, whether the task row's lock was held at each write. */
function observeWrites(fake: ReturnType<typeof setup>) {
  const seen = new Map<PgTable, boolean[]>();
  const sample = (table: PgTable) => {
    const list = seen.get(table) ?? [];
    list.push(fake.rowLocked(schema.tasks, TASK));
    seen.set(table, list);
  };
  fake.hooks.beforeInsert = sample;
  fake.hooks.beforeUpdate = sample;
  return (table: PgTable, why: string) => {
    const list = seen.get(table) ?? [];
    expect(list.length, `${why}: a write was observed`).toBeGreaterThan(0);
    expect(list, `${why}: the task row lock was held at every write`).not.toContain(false);
  };
}

async function patch(path: string, body: Record<string, unknown>) {
  const res = await app.request(`/${TASK}/${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { code?: string } };
}

const choice = (over: Record<string, unknown>) => ({
  userId: USER,
  taskId: TASK,
  stepId: '08c-code-review',
  role: 'default',
  cliProviderId: CODEX,
  requestedEffort: null,
  remember: false,
  ...over,
});

describe('the task row lock is held at every CLI-choice write', () => {
  beforeEach(() => h.add.mockClear());

  it('writeStepCliChoice: the choice insert', async () => {
    const fake = setup();
    const check = observeWrites(fake);
    await writeStepCliChoice(fake.db as unknown as Database, choice({}));
    check(schema.taskStepCliChoices, 'choice insert');
  });

  it.each([
    ['default', schema.userStepCliPreferences],
    ['fixer', schema.userStepCliRolePreferences],
  ])('writeStepCliChoice remember, role %s: the saved-preference upsert', async (role, table) => {
    const fake = setup();
    const check = observeWrites(fake);
    await writeStepCliChoice(fake.db as unknown as Database, choice({ role, remember: true }));
    check(schema.taskStepCliChoices, 'choice insert');
    check(table, 'saved preference upsert');
  });

  it('PATCH summary-cli: the tasks update', async () => {
    const fake = setup();
    const check = observeWrites(fake);
    expect((await patch('summary-cli', { summaryCliProviderId: CODEX })).status).toBe(200);
    check(schema.tasks, 'summaryCliProviderId update');
  });

  it('PATCH cli-provider on a done model-health step: the choice insert and the default update', async () => {
    const fake = setup();
    fake.insert(schema.taskSteps, {
      id: STEP_ROW,
      taskId: TASK,
      stepId: '00-model-health-workflow',
      stepIndex: 0,
      status: 'done',
      iterationCount: 0,
    });
    const check = observeWrites(fake);
    const res = await patch('steps/00-model-health-workflow/cli-provider', {
      cliProviderId: CODEX,
    });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.tasks)).toMatchObject([{ cliProviderId: CODEX }]);
    check(schema.taskStepCliChoices, 'choice insert');
    check(schema.tasks, 'tasks.cliProviderId update');
  });

  it('PATCH cli-provider re-running a pending step: the choice insert', async () => {
    const fake = setup();
    fake.insert(schema.taskSteps, {
      id: STEP_ROW,
      taskId: TASK,
      stepId: '08c-code-review',
      stepIndex: 0,
      status: 'pending',
      iterationCount: 0,
    });
    const check = observeWrites(fake);
    const res = await patch('steps/08c-code-review/cli-provider', { cliProviderId: CODEX });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([{ cliProviderId: CODEX }]);
    check(schema.taskStepCliChoices, 'choice insert on the re-run path');
  });
});
