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
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
import { seedStepCatalog } from './step-flags-fixture.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const CLAUDE_A = '00000000-0000-4000-8000-0000000000b1';
const CODEX = '00000000-0000-4000-8000-0000000000b2';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.route('/', taskRoutes);
app.onError(errorHandler);

/** A running task whose default CLI is claude row A, on a template with the given declared deps. */
function setup(template: Record<string, unknown> | null | undefined) {
  const fake = createFakeDb({
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
  });
  seedStepCatalog(fake);
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status: 'running',
    orchestrationEpoch: 1,
    cliProviderId: CLAUDE_A,
    envTemplateId: template === undefined ? null : TEMPLATE,
  });
  if (template !== undefined)
    fake.insert(schema.envTemplates, {
      id: TEMPLATE,
      userId: USER,
      name: 't',
      baseImage: 'img',
      declaredDeps: template,
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

async function patch(path: string, body: Record<string, unknown>) {
  const res = await app.request(`/${TASK}/${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { code?: string } };
}
const pick = (body: Record<string, unknown>) => patch('steps/08c-code-review/cli-provider', body);
const LOCKED = 'composed_lsp_provider_locked';
const V2 = { lspInstallContractVersion: 2 };

function expectUntouched(fake: ReturnType<typeof setup>) {
  expect(fake.rows(schema.taskStepCliChoices)).toEqual([]);
  expect(fake.rows(schema.userStepCliPreferences)).toEqual([]);
  expect(fake.rows(schema.userStepCliRolePreferences)).toEqual([]);
  expect(fake.rows(schema.tasks)).toMatchObject([{ cliProviderId: CLAUDE_A }]);
  expect(fake.rows(schema.taskEvents)).toEqual([]);
}

describe('composed LSP provider lock on the step CLI switch', () => {
  beforeEach(() => h.add.mockClear());

  it('refuses codex on a contract-2 task and writes nothing', async () => {
    const fake = setup(V2);
    const res = await pick({ cliProviderId: CODEX, remember: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LOCKED);
    expectUntouched(fake);
  });

  it('refuses codex for a named role (seat)', async () => {
    const fake = setup(V2);
    const res = await pick({ cliProviderId: CODEX, role: 'fixer' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LOCKED);
    expectUntouched(fake);
  });

  it.each([
    ['an absent contract', {}],
    ['contract 1', { lspInstallContractVersion: 1 }],
    ['no template', undefined],
  ])('allows codex with %s', async (_label, template) => {
    const fake = setup(template);
    expect((await pick({ cliProviderId: CODEX })).status).toBe(200);
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([{ cliProviderId: CODEX }]);
  });

  it('still allows clearing the slot and the locked provider itself', async () => {
    const fake = setup(V2);
    expect((await pick({ cliProviderId: null })).status).toBe(200);
    expect((await pick({ cliProviderId: CLAUDE_A, remember: true })).status).toBe(200);
    expect(fake.rows(schema.userStepCliPreferences)).toMatchObject([{ cliProviderId: CLAUDE_A }]);
  });
});

describe('composed LSP provider lock on the summary CLI', () => {
  it('refuses codex on a contract-2 task and allows null', async () => {
    const fake = setup(V2);
    const res = await patch('summary-cli', { summaryCliProviderId: CODEX });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LOCKED);
    expect(fake.rows(schema.tasks)).toMatchObject([{ summaryCliProviderId: null }]);
    expect((await patch('summary-cli', { summaryCliProviderId: null })).status).toBe(200);
  });

  it('allows codex without the contract', async () => {
    setup({ lspInstallContractVersion: 1 });
    expect((await patch('summary-cli', { summaryCliProviderId: CODEX })).status).toBe(200);
  });
});
