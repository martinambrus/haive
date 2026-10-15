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

type Outcome = 'ok' | 'refused' | 'error' | 'running';
type Counts = Record<Outcome, number>;
interface CustomEntry extends Counts {
  tool: string;
  action: string;
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
  }>;
  totals: Record<string, unknown>;
  coverage: Record<string, number>;
  callTotals: { customTools: CustomEntry[] };
}
interface CustomGroup {
  task_step_id: string | null;
  tool: string;
  action: string;
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
const identity = (tool: string, action: string) => JSON.stringify([tool, action]);
const inAnyOrder = (entries: CustomEntry[]) =>
  [...entries].sort((a, b) => identity(a.tool, a.action).localeCompare(identity(b.tool, b.action)));

describe.skipIf(!url)('GET /tasks/:id/tool-usage call groups, on Postgres', () => {
  let db: Database;
  let stepA: string;
  let stepB: string;
  let stepC: string;

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

  const wipe = async () => {
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
    expect(Object.keys(body.callTotals).sort()).toEqual(['customTools']);
    for (const step of body.steps) {
      expect(Object.keys(step).sort()).toEqual([
        'customTools',
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
      expect(inAnyOrder(stepOf(body, id).customTools)).toEqual(
        inAnyOrder(customFromOracle(groups, id)),
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
    expect(inAnyOrder(body.callTotals.customTools)).toEqual(inAnyOrder(customFromOracle(groups)));
    expect(body.callTotals.customTools).toEqual([
      custom('lookup', 'http-get', { ok: 5, refused: 3, error: 3, running: 1 }),
      custom('notes', 'rag-query', { ok: 2 }),
      custom('', '', { refused: 1 }),
    ]);
  });

  it('answers 404 for another user task, which holds rows', async () => {
    const held = await db
      .select({ id: schema.customToolCalls.id })
      .from(schema.customToolCalls)
      .where(eq(schema.customToolCalls.taskId, FOREIGN_TASK));
    expect(held).toHaveLength(40);
    const res = await app.request(`/tasks/${FOREIGN_TASK}/tool-usage`);
    expect(res.status).toBe(404);
  });
});
