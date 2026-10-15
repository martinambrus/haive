import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const url = process.env.TASK_TOOL_USAGE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_tool_usage_test'))
  throw new Error('Use a dedicated task_tool_usage_test database for the task tool usage tests');

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000f1');
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
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => 'USD', getBoolean: async () => false },
}));
vi.mock('@haive/shared/stats-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/stats-server')>()),
  resolveCostDisplay: async () => ({ currency: 'USD', rate: 1 }),
}));

import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDatabase, schema, type Database } from '@haive/database';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const OTHER_USER = '00000000-0000-4000-8000-0000000000f2';
const TASK = '00000000-0000-4000-8000-0000000000f3';
const DECOY_TASK = '00000000-0000-4000-8000-0000000000f4';
const FOREIGN_TASK = '00000000-0000-4000-8000-0000000000f5';
const STOPPED_TASK = '00000000-0000-4000-8000-0000000000f6';

type Outcome = 'ok' | 'refused' | 'error' | 'running';
type Access = 'read' | 'write';
type Counts = Record<Outcome, number>;
interface CustomEntry extends Counts {
  tool: string;
  action: string;
}
interface IntegrationEntry extends Counts {
  providerId: string;
  tool: string;
  access: Access;
}
interface Body {
  taskId: string;
  steps: Array<{
    stepRowId: string;
    stepId: string;
    round: number;
    title: string;
    usage: Record<string, unknown> | null;
    customTools: CustomEntry[];
    integrations: IntegrationEntry[];
  }>;
  totals: Record<string, unknown>;
  coverage: Record<string, number>;
  callTotals: { customTools: CustomEntry[]; integrations: IntegrationEntry[] };
}
interface CustomGroup {
  task_step_id: string | null;
  tool: string;
  action: string;
  outcome: Outcome;
  n: number;
}
interface IntegrationGroup {
  task_step_id: string | null;
  provider_id: string;
  tool: string;
  access: Access;
  outcome: Outcome;
  n: number;
}

const OBSERVED = {
  source: 'stream' as const,
  coverage: 'full' as const,
  tools: { Bash: 2 },
  mcp: [{ server: 'haive-custom', tool: 'lookup', calls: 3 }],
  subagents: [],
  skills: { invoked: [], read: [] },
  agents: { assigned: [], read: [] },
  loaded: null,
};

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

const counts = (over: Partial<Counts> = {}): Counts => ({
  ok: 0,
  refused: 0,
  error: 0,
  running: 0,
  ...over,
});
const custom = (tool: string, action: string, over: Partial<Counts> = {}): CustomEntry => ({
  tool,
  action,
  ...counts(over),
});
const integration = (
  providerId: string,
  tool: string,
  access: Access,
  over: Partial<Counts> = {},
): IntegrationEntry => ({ providerId, tool, access, ...counts(over) });
const identity = (...parts: string[]) => JSON.stringify(parts);
const customIdentity = (e: CustomEntry) => identity(e.tool, e.action);
const integrationIdentity = (e: IntegrationEntry) => identity(e.providerId, e.tool, e.access);
const inAnyOrder = <E>(entries: E[], identityOf: (entry: E) => string) =>
  [...entries].sort((a, b) => identityOf(a).localeCompare(identityOf(b)));

const STEP_ROUTES: Array<[string, (taskId: string) => string]> = [
  ['GET /tasks/:id', (taskId) => `/tasks/${taskId}`],
  ['GET /tasks/:id/steps', (taskId) => `/tasks/${taskId}/steps`],
];

describe.skipIf(!url)('GET /tasks/:id/tool-usage call groups, on Postgres', () => {
  let db: Database;
  let stepA: string;
  let stepB: string;
  let stepC: string;
  let resetStep: string;
  let quietStep: string;

  const fetchBody = async (): Promise<Body> => {
    const res = await app.request(`/tasks/${TASK}/tool-usage`);
    expect(res.status).toBe(200);
    return (await res.json()) as Body;
  };
  const stepOf = (body: Body, id: string) => body.steps.find((s) => s.stepRowId === id)!;

  const customRow = (taskStepId: string, tool: string, action: string, outcome: Outcome) => ({
    taskId: TASK,
    taskStepId: taskStepId as string | null,
    cliInvocationId: null as string | null,
    stepId: 'tu-one',
    tool,
    action,
    outcome,
    durationMs: 5,
  });
  const customRows = (
    n: number,
    taskStepId: string,
    tool: string,
    action: string,
    outcome: Outcome,
    over: { cliInvocationId?: string; taskId?: string; taskStepId?: null } = {},
  ) =>
    Array.from({ length: n }, () => ({ ...customRow(taskStepId, tool, action, outcome), ...over }));

  const customOracle = async (): Promise<CustomGroup[]> =>
    (await db.execute(
      sql`select task_step_id, tool, action, outcome, count(*)::int as n
        from custom_tool_calls where task_id = ${TASK}
        group by task_step_id, tool, action, outcome`,
    )) as unknown as CustomGroup[];
  const customFromOracle = (groups: CustomGroup[], stepRowId?: string): CustomEntry[] => {
    const byIdentity = new Map<string, CustomEntry>();
    for (const g of groups) {
      if (stepRowId !== undefined && g.task_step_id !== stepRowId) continue;
      const known = byIdentity.get(identity(g.tool, g.action)) ?? custom(g.tool, g.action);
      known[g.outcome] += g.n;
      byIdentity.set(identity(g.tool, g.action), known);
    }
    return [...byIdentity.values()];
  };

  const integrationRows = (
    n: number,
    taskStepId: string,
    providerId: string,
    tool: string,
    access: Access,
    outcome: Outcome,
    over: { cliInvocationId?: string; taskId?: string; taskStepId?: null } = {},
  ) =>
    Array.from({ length: n }, () => ({
      taskId: TASK,
      taskStepId: taskStepId as string | null,
      cliInvocationId: null as string | null,
      providerId,
      tool,
      access,
      surface: 'rest' as const,
      outcome,
      ...over,
    }));
  const integrationOracle = async (): Promise<IntegrationGroup[]> =>
    (await db.execute(
      sql`select task_step_id, provider_id, tool, access, outcome, count(*)::int as n
        from integration_calls where task_id = ${TASK}
        group by task_step_id, provider_id, tool, access, outcome`,
    )) as unknown as IntegrationGroup[];
  const integrationsFromOracle = (
    groups: IntegrationGroup[],
    stepRowId?: string,
  ): IntegrationEntry[] => {
    const byIdentity = new Map<string, IntegrationEntry>();
    for (const g of groups) {
      if (stepRowId !== undefined && g.task_step_id !== stepRowId) continue;
      const entry = integration(g.provider_id, g.tool, g.access);
      const known = byIdentity.get(integrationIdentity(entry)) ?? entry;
      known[g.outcome] += g.n;
      byIdentity.set(integrationIdentity(entry), known);
    }
    return [...byIdentity.values()];
  };

  const wipe = async () => {
    await db
      .delete(schema.integrationCalls)
      .where(
        inArray(schema.integrationCalls.taskId, [TASK, DECOY_TASK, FOREIGN_TASK, STOPPED_TASK]),
      );
    await db.delete(schema.tasks).where(inArray(schema.tasks.userId, [USER, OTHER_USER]));
    await db.delete(schema.users).where(inArray(schema.users.id, [USER, OTHER_USER]));
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await wipe();
    await db.insert(schema.users).values(
      [USER, OTHER_USER].map((id) => ({
        id,
        emailEncrypted: 'x',
        emailBlindIndex: `task-tool-usage-${id}`,
        passwordHash: 'x',
      })),
    );
    await db.insert(schema.tasks).values(
      [
        { id: TASK, userId: USER },
        { id: DECOY_TASK, userId: USER },
        { id: FOREIGN_TASK, userId: OTHER_USER },
        { id: STOPPED_TASK, userId: USER },
      ].map((t) => ({ ...t, type: 'workflow', title: t.id, status: 'running' as const })),
    );
    const steps = await db
      .insert(schema.taskSteps)
      .values([
        { taskId: TASK, stepId: 'tu-one', stepIndex: 1, round: 0, title: 'One' },
        { taskId: TASK, stepId: 'tu-two', stepIndex: 2, round: 0, title: 'Two' },
        { taskId: TASK, stepId: 'tu-one', stepIndex: 1, round: 1, title: 'One again' },
        { taskId: DECOY_TASK, stepId: 'tu-one', stepIndex: 1, round: 0, title: 'Decoy' },
        { taskId: FOREIGN_TASK, stepId: 'tu-one', stepIndex: 1, round: 0, title: 'Foreign' },
        { taskId: STOPPED_TASK, stepId: 'tu-reset', stepIndex: 1, round: 0, title: 'Reset' },
        { taskId: STOPPED_TASK, stepId: 'tu-quiet', stepIndex: 2, round: 0, title: 'Quiet' },
      ])
      .returning({
        id: schema.taskSteps.id,
        taskId: schema.taskSteps.taskId,
        round: schema.taskSteps.round,
        stepId: schema.taskSteps.stepId,
      });
    const pick = (taskId: string, stepId: string, round = 0) =>
      steps.find((s) => s.taskId === taskId && s.stepId === stepId && s.round === round)!.id;
    stepA = pick(TASK, 'tu-one');
    stepB = pick(TASK, 'tu-two');
    stepC = pick(TASK, 'tu-one', 1);
    const decoyStep = pick(DECOY_TASK, 'tu-one');
    const foreignStep = pick(FOREIGN_TASK, 'tu-one');
    resetStep = pick(STOPPED_TASK, 'tu-reset');
    quietStep = pick(STOPPED_TASK, 'tu-quiet');

    const [live] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: TASK, taskStepId: stepA, mode: 'cli', prompt: 'p', toolUsage: OBSERVED })
      .returning({ id: schema.cliInvocations.id });
    const [replaced] = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: TASK,
        taskStepId: stepA,
        mode: 'cli',
        prompt: 'p',
        toolUsage: { ...OBSERVED, tools: { Bash: 100 } },
        supersededAt: new Date('2026-10-14T07:00:00.000Z'),
      })
      .returning({ id: schema.cliInvocations.id });

    await db
      .insert(schema.customToolCalls)
      .values([
        ...customRows(3, stepA, 'lookup', 'http-get', 'ok', { cliInvocationId: live!.id }),
        ...customRows(1, stepA, 'lookup', 'http-get', 'ok', { cliInvocationId: replaced!.id }),
        ...customRows(1, stepA, 'lookup', 'http-get', 'refused'),
        ...customRows(1, stepA, 'lookup', 'http-get', 'error'),
        ...customRows(1, stepA, 'lookup', 'http-get', 'running'),
        ...customRows(2, stepA, 'notes', 'rag-query', 'ok'),
        ...customRows(1, stepC, 'lookup', 'http-get', 'ok'),
        ...customRows(2, stepC, 'lookup', 'http-get', 'error'),
        ...customRows(1, stepC, '', '', 'refused'),
        ...customRows(2, stepA, 'lookup', 'http-get', 'refused', { taskStepId: null }),
        ...customRows(50, decoyStep, 'lookup', 'http-get', 'ok', { taskId: DECOY_TASK }),
        ...customRows(40, foreignStep, 'lookup', 'http-get', 'ok', { taskId: FOREIGN_TASK }),
      ]);

    const READ_PR = 'get_pull_request_state';
    const OPEN_PR = 'open_pull_request';
    await db.insert(schema.integrationCalls).values([
      ...integrationRows(2, stepA, 'github', READ_PR, 'read', 'ok', { cliInvocationId: live!.id }),
      ...integrationRows(1, stepA, 'github', READ_PR, 'read', 'ok', {
        cliInvocationId: replaced!.id,
      }),
      ...integrationRows(1, stepA, 'github', READ_PR, 'read', 'error'),
      ...integrationRows(1, stepA, 'github', OPEN_PR, 'write', 'ok'),
      ...integrationRows(2, stepA, 'github', OPEN_PR, 'write', 'refused'),
      ...integrationRows(1, stepA, 'github', OPEN_PR, 'write', 'running'),
      ...integrationRows(1, stepA, 'gitlab', READ_PR, 'read', 'ok'),
      ...integrationRows(1, stepC, 'github', READ_PR, 'read', 'ok'),
      ...integrationRows(2, stepC, 'github', READ_PR, 'read', 'error'),
      ...integrationRows(1, stepC, 'gitlab', 'open_merge_request', 'write', 'refused'),
      ...integrationRows(3, stepA, 'github', OPEN_PR, 'write', 'refused', { taskStepId: null }),
      ...integrationRows(50, decoyStep, 'github', READ_PR, 'read', 'ok', { taskId: DECOY_TASK }),
      ...integrationRows(40, foreignStep, 'github', READ_PR, 'read', 'ok', {
        taskId: FOREIGN_TASK,
      }),
    ]);

    const [stopped] = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: STOPPED_TASK,
        taskStepId: resetStep,
        mode: 'cli',
        prompt: 'p',
        toolUsage: OBSERVED,
        supersededAt: new Date('2026-10-14T07:00:00.000Z'),
      })
      .returning({ id: schema.cliInvocations.id });
    const ofStopped = { taskId: STOPPED_TASK, cliInvocationId: stopped!.id };
    await db
      .insert(schema.customToolCalls)
      .values(customRows(2, resetStep, 'lookup', 'http-get', 'ok', ofStopped));
    await db
      .insert(schema.integrationCalls)
      .values(integrationRows(1, resetStep, 'github', READ_PR, 'read', 'refused', ofStopped));
  });

  afterAll(async () => {
    await wipe();
    await db.$client.end({ timeout: 5 });
  });

  it('keeps the fields it already answered with', async () => {
    const body = await fetchBody();
    expect(body.taskId).toBe(TASK);
    expect(body.steps.map((s) => [s.stepRowId, s.stepId, s.round, s.title])).toEqual([
      [stepA, 'tu-one', 0, 'One'],
      [stepB, 'tu-two', 0, 'Two'],
      [stepC, 'tu-one', 1, 'One again'],
    ]);
    const observed = {
      runs: 1,
      observable: 1,
      partial: 0,
      unobservable: 0,
      unrecorded: 0,
      personasAssigned: [],
      personasRead: [],
      skillsInvoked: [],
      skillsRead: [],
      mcp: [{ server: 'haive-custom', tool: 'lookup', calls: 3 }],
      subagents: [],
      toolCalls: 2,
    };
    expect(stepOf(body, stepA).usage).toEqual(observed);
    expect(stepOf(body, stepB).usage).toBeNull();
    expect(stepOf(body, stepC).usage).toBeNull();
    expect(body.totals).toEqual(observed);
    expect(body.coverage).toEqual({
      total: 1,
      observable: 1,
      partial: 0,
      unobservable: 0,
      unrecorded: 0,
    });
  });

  it('adds nothing but the call groups to the answer', async () => {
    const body = await fetchBody();
    expect(Object.keys(body).sort()).toEqual([
      'callTotals',
      'coverage',
      'steps',
      'taskId',
      'totals',
    ]);
    expect(Object.keys(body.callTotals).sort()).toEqual(['customTools', 'integrations']);
    for (const step of body.steps) {
      expect(Object.keys(step).sort()).toEqual([
        'customTools',
        'integrations',
        'round',
        'stepId',
        'stepRowId',
        'title',
        'usage',
      ]);
    }
  });

  it('groups each step by the rows the database holds for it', async () => {
    const body = await fetchBody();
    const groups = await customOracle();
    expect(groups.length).toBeGreaterThan(0);
    for (const id of [stepA, stepB, stepC]) {
      expect(inAnyOrder(stepOf(body, id).customTools, customIdentity)).toEqual(
        inAnyOrder(customFromOracle(groups, id), customIdentity),
      );
    }
  });

  it('counts every outcome of a tool apart, a replaced run and a refusal included', async () => {
    const body = await fetchBody();
    expect(stepOf(body, stepA).customTools).toEqual([
      custom('lookup', 'http-get', { ok: 4, refused: 1, error: 1, running: 1 }),
      custom('notes', 'rag-query', { ok: 2 }),
    ]);
  });

  it('keeps a fix-loop round of a step apart from its first round', async () => {
    const body = await fetchBody();
    expect(stepOf(body, stepC).customTools).toEqual([
      custom('lookup', 'http-get', { ok: 1, error: 2 }),
      custom('', '', { refused: 1 }),
    ]);
  });

  it('answers [] for a step with no row', async () => {
    const body = await fetchBody();
    expect(stepOf(body, stepB).customTools).toEqual([]);
  });

  it('totals every row of the task, one with no step among them, and no other task', async () => {
    const body = await fetchBody();
    const groups = await customOracle();
    expect(inAnyOrder(body.callTotals.customTools, customIdentity)).toEqual(
      inAnyOrder(customFromOracle(groups), customIdentity),
    );
    expect(body.callTotals.customTools).toEqual([
      custom('lookup', 'http-get', { ok: 5, refused: 3, error: 3, running: 1 }),
      custom('notes', 'rag-query', { ok: 2 }),
      custom('', '', { refused: 1 }),
    ]);
  });

  it('groups each step integration calls by the rows the database holds for it', async () => {
    const body = await fetchBody();
    const groups = await integrationOracle();
    expect(groups.length).toBeGreaterThan(0);
    for (const id of [stepA, stepB, stepC]) {
      expect(inAnyOrder(stepOf(body, id).integrations, integrationIdentity)).toEqual(
        inAnyOrder(integrationsFromOracle(groups, id), integrationIdentity),
      );
    }
  });

  it('counts the integration calls of a tool by outcome, a replaced run and a refusal included', async () => {
    const body = await fetchBody();
    expect(stepOf(body, stepA).integrations).toEqual([
      integration('github', 'get_pull_request_state', 'read', { ok: 3, error: 1 }),
      integration('github', 'open_pull_request', 'write', { ok: 1, refused: 2, running: 1 }),
      integration('gitlab', 'get_pull_request_state', 'read', { ok: 1 }),
    ]);
  });

  it('keeps the integration calls of a fix-loop round apart from its first round', async () => {
    const body = await fetchBody();
    expect(stepOf(body, stepC).integrations).toEqual([
      integration('github', 'get_pull_request_state', 'read', { ok: 1, error: 2 }),
      integration('gitlab', 'open_merge_request', 'write', { refused: 1 }),
    ]);
  });

  it('answers [] for a step with no integration row', async () => {
    const body = await fetchBody();
    expect(stepOf(body, stepB).integrations).toEqual([]);
  });

  it('totals every integration row of the task, one with no step among them, and no other task', async () => {
    const body = await fetchBody();
    const groups = await integrationOracle();
    expect(inAnyOrder(body.callTotals.integrations, integrationIdentity)).toEqual(
      inAnyOrder(integrationsFromOracle(groups), integrationIdentity),
    );
    expect(body.callTotals.integrations).toEqual([
      integration('github', 'get_pull_request_state', 'read', { ok: 4, error: 3 }),
      integration('github', 'open_pull_request', 'write', { ok: 1, refused: 5, running: 1 }),
      integration('gitlab', 'get_pull_request_state', 'read', { ok: 1 }),
      integration('gitlab', 'open_merge_request', 'write', { refused: 1 }),
    ]);
  });

  it('answers 404 for another user task, which holds rows', async () => {
    const held = await db
      .select({ id: schema.customToolCalls.id })
      .from(schema.customToolCalls)
      .where(eq(schema.customToolCalls.taskId, FOREIGN_TASK));
    expect(held).toHaveLength(40);
    const heldIntegrations = await db
      .select({ id: schema.integrationCalls.id })
      .from(schema.integrationCalls)
      .where(eq(schema.integrationCalls.taskId, FOREIGN_TASK));
    expect(heldIntegrations).toHaveLength(40);
    const res = await app.request(`/tasks/${FOREIGN_TASK}/tool-usage`);
    expect(res.status).toBe(404);
  });

  describe.each(STEP_ROUTES)('%s step counters', (_route, pathOf) => {
    const countersOf = async (taskId: string) => {
      const res = await app.request(pathOf(taskId));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        steps: Array<{ id: string; cliInvocationCount: number; loggedCallCount: number }>;
      };
      return new Map(
        body.steps.map((s) => [s.id, [s.cliInvocationCount, s.loggedCallCount]] as const),
      );
    };

    it('counts the rows of both tables a step owns, a replaced run and a refusal included', async () => {
      const counters = await countersOf(TASK);
      expect(counters.get(stepA)).toEqual([1, 18]);
      expect(counters.get(stepB)).toEqual([0, 0]);
      expect(counters.get(stepC)).toEqual([0, 8]);
    });

    it('counts what the database holds for the step, the rows with no step left out', async () => {
      const counters = await countersOf(TASK);
      const groups = [...(await customOracle()), ...(await integrationOracle())];
      expect(groups.some((g) => g.task_step_id === null)).toBe(true);
      for (const id of [stepA, stepB, stepC]) {
        const held = groups.filter((g) => g.task_step_id === id).reduce((sum, g) => sum + g.n, 0);
        expect(counters.get(id)![1]).toBe(held);
      }
    });

    it('counts the calls of a step whose only run was replaced', async () => {
      const counters = await countersOf(STOPPED_TASK);
      expect(counters.get(resetStep)).toEqual([0, 3]);
      expect(counters.get(quietStep)).toEqual([0, 0]);
    });
  });
});
