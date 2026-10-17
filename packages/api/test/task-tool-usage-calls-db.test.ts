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
const DETACHED_TASK = '00000000-0000-4000-8000-0000000000f7';
const NO_CALLS_TASK = '00000000-0000-4000-8000-0000000000f8';
const LIVE_TASK = '00000000-0000-4000-8000-0000000000f9';

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

describe.skipIf(!url)('GET /tasks/:id/tool-usage call groups, on Postgres', () => {
  let db: Database;
  let stepA: string;
  let stepB: string;
  let stepC: string;
  let resetStep: string;
  let liveStep: string;

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
        inArray(schema.integrationCalls.taskId, [
          TASK,
          DECOY_TASK,
          FOREIGN_TASK,
          STOPPED_TASK,
          DETACHED_TASK,
          LIVE_TASK,
        ]),
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
        { id: DETACHED_TASK, userId: USER },
        { id: NO_CALLS_TASK, userId: USER },
        { id: LIVE_TASK, userId: USER },
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
        { taskId: NO_CALLS_TASK, stepId: 'tu-silent', stepIndex: 1, round: 0, title: 'Silent' },
        { taskId: LIVE_TASK, stepId: 'tu-live', stepIndex: 1, round: 0, title: 'Live' },
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
    liveStep = pick(LIVE_TASK, 'tu-live');

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
        ...customRows(2, decoyStep, 'lookup', 'http-get', 'running', { taskId: DECOY_TASK }),
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
      ...integrationRows(2, decoyStep, 'github', READ_PR, 'read', 'running', {
        taskId: DECOY_TASK,
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

    const ofDetached = { taskId: DETACHED_TASK, taskStepId: null };
    await db
      .insert(schema.customToolCalls)
      .values(customRows(2, stepA, 'lookup', 'http-get', 'ok', ofDetached));
    await db
      .insert(schema.integrationCalls)
      .values(integrationRows(1, stepA, 'github', READ_PR, 'read', 'refused', ofDetached));
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
      inFlight: 0,
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
      inFlight: 0,
    });
  });

  it('counts a run still in flight apart from an ended run with no record', async () => {
    const FLIGHT_TASK = '00000000-0000-4000-8000-0000000000fa';
    await db.insert(schema.tasks).values({
      id: FLIGHT_TASK,
      userId: USER,
      type: 'workflow',
      title: FLIGHT_TASK,
      status: 'running',
    });
    const [flightStep] = await db
      .insert(schema.taskSteps)
      .values({ taskId: FLIGHT_TASK, stepId: 'tu-flight', stepIndex: 1, round: 0, title: 'Flight' })
      .returning({ id: schema.taskSteps.id });
    const run = {
      taskId: FLIGHT_TASK,
      taskStepId: flightStep!.id,
      mode: 'cli' as const,
      prompt: 'p',
    };
    const endedAt = new Date('2026-10-14T08:00:00.000Z');
    await db
      .insert(schema.cliInvocations)
      .values([{ ...run, endedAt }, { ...run }, { ...run, endedAt, toolUsage: OBSERVED }]);
    const res = await app.request(`/tasks/${FLIGHT_TASK}/tool-usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coverage: Record<string, number>;
      steps: Array<{ usage: Record<string, number> | null }>;
    };
    expect(body.coverage).toEqual({
      total: 3,
      observable: 1,
      partial: 0,
      unobservable: 0,
      unrecorded: 1,
      inFlight: 1,
    });
    expect(body.steps[0]!.usage).toMatchObject({ unrecorded: 1, inFlight: 1 });
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

  describe('GET /tasks/:id call counts', () => {
    const detail = async (taskId: string) => {
      const res = await app.request(`/tasks/${taskId}`);
      expect(res.status).toBe(200);
      return (await res.json()) as {
        loggedCallCount: number;
        runningCallCount: number;
        finishedRunsRevision: string;
        steps: Array<{ cliInvocationCount: number }>;
      };
    };
    const runningHeldBy = async (taskId: string) => {
      const [row] = (await db.execute(
        sql`select
          (select count(*)::int from custom_tool_calls where task_id = ${taskId} and outcome = 'running') as custom,
          (select count(*)::int from integration_calls where task_id = ${taskId} and outcome = 'running') as integration`,
      )) as unknown as Array<{ custom: number; integration: number }>;
      return row!;
    };
    const heldBy = async (taskId: string) => {
      const [row] = (await db.execute(
        sql`select count(*)::int as total, (count(*) filter (where task_step_id is null))::int as detached
          from (select task_step_id from custom_tool_calls where task_id = ${taskId}
            union all select task_step_id from integration_calls where task_id = ${taskId}) calls`,
      )) as unknown as Array<{ total: number; detached: number }>;
      return row!;
    };

    it('counts the rows of both tables the task owns, those no step owns among them', async () => {
      const held = await heldBy(TASK);
      expect(held).toEqual({ total: 31, detached: 5 });
      expect((await detail(TASK)).loggedCallCount).toBe(held.total);
    });

    it('counts the calls of a task whose only run was replaced', async () => {
      const body = await detail(STOPPED_TASK);
      expect(body.steps.map((s) => s.cliInvocationCount)).toEqual([0, 0]);
      expect(body.loggedCallCount).toBe(3);
    });

    it('counts the calls of a task whose rows all have no step', async () => {
      expect(await heldBy(DETACHED_TASK)).toEqual({ total: 3, detached: 3 });
      expect((await detail(DETACHED_TASK)).loggedCallCount).toBe(3);
    });

    it('is 0 for a task that logged no call', async () => {
      expect(await heldBy(NO_CALLS_TASK)).toEqual({ total: 0, detached: 0 });
      expect((await detail(NO_CALLS_TASK)).loggedCallCount).toBe(0);
    });

    it('counts the running rows of both tables the task owns, and those of no other task', async () => {
      expect(await runningHeldBy(DECOY_TASK)).toEqual({ custom: 2, integration: 2 });
      expect(await runningHeldBy(TASK)).toEqual({ custom: 1, integration: 1 });
      expect((await detail(TASK)).runningCallCount).toBe(2);
    });

    it.each([
      ['rows that all settled', STOPPED_TASK, 3],
      ['settled rows no step owns', DETACHED_TASK, 3],
      ['no row at all', NO_CALLS_TASK, 0],
    ])('counts no running row for a task with %s', async (_name, taskId, logged) => {
      expect(await runningHeldBy(taskId)).toEqual({ custom: 0, integration: 0 });
      const body = await detail(taskId);
      expect([body.loggedCallCount, body.runningCallCount]).toEqual([logged, 0]);
    });

    it('follows a call no step owns from running to its outcome, in either table', async () => {
      const answer = async () => {
        const body = await detail(LIVE_TASK);
        return [body.loggedCallCount, body.runningCallCount];
      };
      const ofLive = { taskId: LIVE_TASK, taskStepId: null };
      expect(await answer()).toEqual([0, 0]);

      const [custom] = await db
        .insert(schema.customToolCalls)
        .values(customRows(1, stepA, 'lookup', 'http-get', 'running', ofLive))
        .returning({ id: schema.customToolCalls.id });
      const [integration] = await db
        .insert(schema.integrationCalls)
        .values(
          integrationRows(1, stepA, 'github', 'open_pull_request', 'write', 'running', ofLive),
        )
        .returning({ id: schema.integrationCalls.id });
      expect(await answer()).toEqual([2, 2]);

      await db
        .update(schema.customToolCalls)
        .set({ outcome: 'ok' })
        .where(eq(schema.customToolCalls.id, custom!.id));
      expect(await answer()).toEqual([2, 1]);

      await db
        .update(schema.integrationCalls)
        .set({ outcome: 'error' })
        .where(eq(schema.integrationCalls.id, integration!.id));
      expect(await answer()).toEqual([2, 0]);

      await db
        .insert(schema.customToolCalls)
        .values(customRows(1, stepA, 'lookup', 'http-get', 'refused', ofLive));
      expect(await answer()).toEqual([3, 0]);
    });

    describe('finishedRunsRevision', () => {
      const revision = async () => (await detail(LIVE_TASK)).finishedRunsRevision;
      const at = (time: string) => new Date(`2026-10-16T${time}.000Z`);
      const add = async (over: Partial<typeof schema.cliInvocations.$inferInsert> = {}) => {
        const [row] = await db
          .insert(schema.cliInvocations)
          .values({ taskId: LIVE_TASK, taskStepId: liveStep, mode: 'cli', prompt: 'p', ...over })
          .returning({ id: schema.cliInvocations.id });
        return row!.id;
      };
      const finishedRuns = async () => {
        const [row] = (await db.execute(
          sql`select count(*)::int as n from cli_invocations
            where task_id = ${LIVE_TASK} and superseded_at is null and ended_at is not null
              and (task_step_id is not null or summary_for_step_id is not null)`,
        )) as unknown as Array<{ n: number }>;
        return row!.n;
      };

      it('moves for a run of the task whose result has landed, and for no other run', async () => {
        const none = await revision();
        expect(none).toBe('');

        const running = await add();
        expect(await revision()).toBe(none);

        await db
          .update(schema.cliInvocations)
          .set({ endedAt: at('09:00:00') })
          .where(eq(schema.cliInvocations.id, running));
        const one = await revision();
        expect(one).not.toBe(none);
        expect(await revision()).toBe(one);

        await add({ endedAt: at('09:00:00'), supersededAt: at('09:00:00') });
        expect(await revision()).toBe(one);

        await add({ taskStepId: null, summaryForStepId: liveStep, endedAt: at('09:00:00') });
        const two = await revision();
        expect(two).not.toBe(one);

        await add({ taskStepId: null, endedAt: at('09:00:00') });
        expect(await revision()).toBe(two);

        const usage = await app.request(`/tasks/${LIVE_TASK}/tool-usage`);
        expect(((await usage.json()) as Body).coverage.total).toBe(2);
        expect((await detail(TASK)).finishedRunsRevision).toBe('');
      });

      it('moves when a finished run is replaced and its replacement finishes, though their number stays', async () => {
        const replaced = await add({ endedAt: at('09:10:00'), toolUsage: OBSERVED });
        const before = { number: await finishedRuns(), revision: await revision() };

        await db
          .update(schema.cliInvocations)
          .set({ supersededAt: at('09:20:00') })
          .where(eq(schema.cliInvocations.id, replaced));
        await add({ endedAt: at('09:30:00'), toolUsage: OBSERVED });
        const after = { number: await finishedRuns(), revision: await revision() };

        expect(after.number).toBe(before.number);
        expect(after.revision).not.toBe(before.revision);
      });

      it('moves when the record of a finished run is written after its end', async () => {
        const ended = await add({ endedAt: at('09:40:00') });
        const before = await revision();

        await db
          .update(schema.cliInvocations)
          .set({ toolUsage: OBSERVED })
          .where(eq(schema.cliInvocations.id, ended));
        expect(await revision()).not.toBe(before);
      });

      it('moves when a finished run ends again', async () => {
        const ended = await add({ endedAt: at('09:50:00'), toolUsage: OBSERVED });
        const before = await revision();

        await db
          .update(schema.cliInvocations)
          .set({ endedAt: at('09:55:00') })
          .where(eq(schema.cliInvocations.id, ended));
        expect(await revision()).not.toBe(before);
      });

      it('tells a replaced run from its replacement even when both ended at the same instant', async () => {
        const replaced = await add({ endedAt: at('10:00:00'), toolUsage: OBSERVED });
        const before = await revision();

        await db
          .update(schema.cliInvocations)
          .set({ supersededAt: at('10:05:00') })
          .where(eq(schema.cliInvocations.id, replaced));
        await add({ endedAt: at('10:00:00'), toolUsage: OBSERVED });
        expect(await revision()).not.toBe(before);
      });
    });
  });
});
