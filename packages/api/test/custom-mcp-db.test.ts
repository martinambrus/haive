import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.CUSTOM_MCP_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/custom_mcp_test'))
  throw new Error('Use a dedicated custom_mcp_test database for the custom MCP route tests');

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  switchOn: undefined as boolean | undefined,
  search: undefined as
    undefined | ((taskId: string, query: string, topK?: number) => Promise<unknown[]>),
  searches: [] as Array<{ taskId: string; query: string; topK: number | undefined }>,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...actual,
    configService: {
      get: async () => null,
      getBoolean: async (key: string, fallback = false) => {
        if (key === actual.CONFIG_KEYS.GLOBAL_KB_ENABLED) return false;
        if (key === actual.CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED) return h.switchOn ?? fallback;
        return fallback;
      },
    },
  };
});
vi.mock('../src/routes/rag.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/routes/rag.js')>();
  return {
    ...actual,
    executeRagSearch: (taskId: string, query: string, topK?: number) => {
      h.searches.push({ taskId, query, topK });
      return h.search
        ? h.search(taskId, query, topK)
        : actual.executeRagSearch(taskId, query, topK);
    },
  };
});

import { signRagToken, type RagSearchHit } from '@haive/shared/rag';
import { signTaskToken, type TaskTokenClaims } from '@haive/shared/task-token';
import { createApiApp } from '../src/index.js';

const SECRET = 'custom-mcp-route-test-secret';
const USER = '00000000-0000-4000-8000-0000000000e1';
const USER_EMAIL_INDEX = 'custom-mcp-test-user';
const TYPE = 'cmcp-type';
const STEP_A = `custom.${TYPE}.alpha`;
const STEP_B = `custom.${TYPE}.beta`;
const STEP_CORE = '07-implement';
const QUERY_MARKER = 'QUERYMARKER-4f1c';
const RESULT_MARKER = 'RESULTMARKER-9b2d';
const BUDGET = 50;
const LIMIT = 64 * 1024;
const COLUMNS = [
  'action',
  'cli_invocation_id',
  'created_at',
  'duration_ms',
  'http_status',
  'id',
  'outcome',
  'reason',
  'response_bytes',
  'step_id',
  'task_id',
  'task_step_id',
  'tool',
];

type Row = Record<string, unknown>;
type RagScope = 'project' | 'global' | 'all';

const ragTool = (name: string, scope: RagScope, topK: number, maxResponseBytes: number) => ({
  name,
  description: `Search the ${scope} knowledge.`,
  action: 'rag-query',
  scope,
  topK,
  maxResponseBytes,
});

const httpTool = {
  name: 'fetch_status',
  description: 'Fetch a status page.',
  action: 'http-get',
  url: 'https://status.example.com/api/{page}',
  query: ['verbose'],
  params: [
    { name: 'page', type: 'string', description: 'Which page.', required: true, maxLength: 64 },
    { name: 'verbose', type: 'boolean', description: 'More detail.', required: false },
  ],
  timeoutMs: 10_000,
  maxResponseBytes: 32_768,
};

const entry = (slug: string, tools: unknown[]) => ({
  slug,
  title: `Step ${slug}`,
  template: 'Do the work.',
  capabilities: [],
  tools,
  timeoutMs: 300_000,
});

const TOOLS_A = [
  ragTool('house_rules', 'global', 3, 2048),
  ragTool('project_notes', 'project', 5, 4096),
  ragTool('everything', 'all', 8, 32_768),
  httpTool,
];
const TOOLS_B = [ragTool('beta_only', 'global', 2, 2048)];

const hit = (over: Partial<RagSearchHit>): RagSearchHit => ({
  sourcePath: 'docs/a.md',
  sectionId: 's1',
  chunkIndex: 0,
  sourceType: 'kb',
  content: 'body',
  denseSim: 0.5,
  tsNorm: 0.2,
  hybrid: 0.4,
  rrf: 0.03,
  scope: 'local',
  ...over,
});

interface Fixture {
  taskId: string;
  stepA: string;
  stepB: string;
  stepCore: string;
  invA: string;
  invB: string;
  invCore: string;
}

describe.skipIf(!url)('POST /custom-mcp/call, on Postgres', () => {
  let db: Database;
  let app: ReturnType<typeof createApiApp>;
  let fx: Fixture;

  async function createTask(customSteps: Record<string, unknown> | null): Promise<string> {
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId: USER, type: TYPE, title: 'custom mcp', status: 'running', customSteps })
      .returning({ id: schema.tasks.id });
    return task!.id;
  }

  async function createFixture(): Promise<Fixture> {
    const taskId = await createTask({
      [STEP_A]: entry('alpha', TOOLS_A),
      [STEP_B]: entry('beta', TOOLS_B),
    });
    const steps = await db
      .insert(schema.taskSteps)
      .values(
        [STEP_A, STEP_B, STEP_CORE].map((stepId, i) => ({
          taskId,
          stepId,
          stepIndex: i + 1,
          title: stepId,
          status: 'waiting_cli' as const,
        })),
      )
      .returning({ id: schema.taskSteps.id, stepId: schema.taskSteps.stepId });
    const stepOf = (stepId: string) => steps.find((s) => s.stepId === stepId)!.id;
    const invocations = await db
      .insert(schema.cliInvocations)
      .values(steps.map((s) => ({ taskId, taskStepId: s.id, mode: 'cli' as const, prompt: 'p' })))
      .returning({ id: schema.cliInvocations.id, taskStepId: schema.cliInvocations.taskStepId });
    const invocationOf = (stepId: string) =>
      invocations.find((i) => i.taskStepId === stepOf(stepId))!.id;
    return {
      taskId,
      stepA: stepOf(STEP_A),
      stepB: stepOf(STEP_B),
      stepCore: stepOf(STEP_CORE),
      invA: invocationOf(STEP_A),
      invB: invocationOf(STEP_B),
      invCore: invocationOf(STEP_CORE),
    };
  }

  const mint = (claims: Partial<TaskTokenClaims> = {}, secret = SECRET): string =>
    signTaskToken(
      {
        aud: 'custom-mcp',
        taskId: fx.taskId,
        taskStepId: fx.stepA,
        cliInvocationId: fx.invA,
        ...claims,
      },
      secret,
    );

  const send = async (
    body: unknown,
    token: string | null = mint(),
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    app.request('/custom-mcp/call', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const callTool = (tool: string, args?: unknown, token?: string | null): Promise<Response> =>
    send({ tool, ...(args === undefined ? {} : { arguments: args }) }, token);

  const rowsFor = async (invocationId?: string): Promise<Row[]> => [
    ...(await db.execute<Row>(
      invocationId
        ? sql`select * from custom_tool_calls where cli_invocation_id = ${invocationId} order by created_at, id`
        : sql`select * from custom_tool_calls order by created_at, id`,
    )),
  ];

  const spendBudget = async (rows = BUDGET) => {
    await db.execute(sql`
      insert into custom_tool_calls
        (task_id, task_step_id, cli_invocation_id, step_id, tool, action, outcome, duration_ms)
      select ${fx.taskId}::uuid, ${fx.stepA}::uuid, ${fx.invA}::uuid, ${STEP_A},
             'house_rules', 'rag-query', 'ok', 1
      from generate_series(1, ${rows}::int)`);
  };

  const refusedRow = (reason: string, over: Row = {}): Row => ({
    task_id: fx.taskId,
    task_step_id: fx.stepA,
    cli_invocation_id: fx.invA,
    step_id: STEP_A,
    tool: '',
    action: '',
    outcome: 'refused',
    reason,
    http_status: null,
    response_bytes: null,
    ...over,
  });

  async function expectOneRow(invocationId: string, expected: Row): Promise<Row> {
    const rows = await rowsFor(invocationId);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(COLUMNS);
    expect(rows[0]).toMatchObject(expected);
    return rows[0]!;
  }

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    app = createApiApp('http://localhost:3000');
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'custom-mcp-test@test.local',
      emailBlindIndex: USER_EMAIL_INDEX,
      passwordHash: 'not-real',
      role: 'admin',
      status: 'active',
      tokenVersion: 0,
    });
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', SECRET);
    h.switchOn = undefined;
    h.searches = [];
    h.search = async () => [];
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
    fx = await createFixture();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('harness: the app, the fixtures and a sibling sandbox route work', () => {
    it('holds the fixtures: a task with two pinned prompt steps and a live invocation per step', async () => {
      const [task] = await db
        .select({ customSteps: schema.tasks.customSteps })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, fx.taskId));
      const [live] = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from cli_invocations
            where task_id = ${fx.taskId} and ended_at is null and superseded_at is null`,
      );

      expect(Object.keys(task!.customSteps ?? {}).sort()).toEqual([STEP_A, STEP_B]);
      expect(live!.n).toBe(3);
    });

    it('answers 404 for a path nobody serves under the mount', async () => {
      const res = await app.request('/custom-mcp/nothing', { method: 'POST' });

      expect(res.status).toBe(404);
    });

    it('serves /rag/search a rag task token through the same app', async () => {
      const token = signTaskToken({ aud: 'rag', taskId: fx.taskId }, SECRET);

      const res = await app.request('/rag/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: 'anything' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hits: [] });
    });
  });

  describe('a valid call', () => {
    it('is served with no session: the route sits outside the login', async () => {
      const res = await callTool('house_rules', { query: 'q' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, text: expect.any(String) });
    });

    it('does not answer a GET, which must never start work', async () => {
      expect((await callTool('house_rules', { query: 'q' })).status).toBe(200);

      const res = await app.request('/custom-mcp/call', { headers: { authorization: 'x' } });

      expect(res.status).toBe(404);
    });
  });

  describe('the token', () => {
    const forgedPayload = (token: string): string => {
      const [version, , mac] = token.split('.');
      const payload = Buffer.from(
        JSON.stringify({
          aud: 'custom-mcp',
          taskId: fx.taskId,
          taskStepId: fx.stepB,
          cliInvocationId: fx.invB,
          exp: 99_999_999_999,
        }),
      ).toString('base64url');
      return `${version}.${payload}.${mac}`;
    };

    it.each([
      ['a forged MAC (another invocation swapped in)', () => forgedPayload(mint())],
      ['an expired token', () => mint({ ttlSeconds: -1 })],
      ['a token signed with another secret', () => mint({}, 'another-secret')],
      ['a rag-audience token with the same claims', () => mint({ aud: 'rag' })],
      ['a ddev-audience token with the same claims', () => mint({ aud: 'ddev' })],
      ['the legacy two-part rag token', () => signRagToken(fx.taskId, SECRET)],
      ['a token with no invocation claim', () => mint({ cliInvocationId: undefined })],
      ['a token with no step claim', () => mint({ taskStepId: undefined })],
      ['a token with its version dropped', () => mint().split('.').slice(1).join('.')],
      ['a token with a fourth part', () => `${mint()}.extra`],
      ['a malformed token', () => 'v1.not.a-token'],
    ])('refuses %s, writes no row and runs nothing', async (_name, mintToken) => {
      const res = await send({ tool: 'house_rules', arguments: { query: 'q' } }, mintToken());

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'invalid or missing custom-mcp token',
        code: null,
      });
      expect(await rowsFor()).toEqual([]);
      expect(h.searches).toEqual([]);
    });

    it.each([
      ['no Authorization header', {}],
      ['an empty Bearer token', { authorization: 'Bearer ' }],
      ['another scheme', { authorization: `Basic ${'x'.repeat(8)}` }],
      ['no scheme', { authorization: 'x'.repeat(8) }],
    ])('refuses %s', async (_name, headers) => {
      const res = await send({ tool: 'house_rules', arguments: { query: 'q' } }, null, headers);

      expect(res.status).toBe(401);
      expect(await rowsFor()).toEqual([]);
      expect(h.searches).toEqual([]);
    });

    it('refuses the same token when the server has no secret', async () => {
      const token = mint();
      vi.stubEnv('CONFIG_ENCRYPTION_KEY', '');

      const res = await send({ tool: 'house_rules', arguments: { query: 'q' } }, token);

      expect(res.status).toBe(500);
      expect(await rowsFor()).toEqual([]);
    });
  });

  describe('the invocation', () => {
    const cases: Array<{ name: string; arrange: () => Promise<string> }> = [
      {
        name: 'an ended invocation',
        arrange: async () => {
          await db
            .update(schema.cliInvocations)
            .set({ endedAt: new Date() })
            .where(eq(schema.cliInvocations.id, fx.invA));
          return mint();
        },
      },
      {
        name: 'a superseded invocation',
        arrange: async () => {
          await db
            .update(schema.cliInvocations)
            .set({ supersededAt: new Date() })
            .where(eq(schema.cliInvocations.id, fx.invA));
          return mint();
        },
      },
      {
        name: 'a token that names another step of the task',
        arrange: async () => mint({ taskStepId: fx.stepB }),
      },
      {
        name: 'a token that names another task',
        arrange: async () => mint({ taskId: await createTask(null) }),
      },
      {
        name: 'an invocation whose step is gone',
        arrange: async () => {
          const token = mint();
          await db.delete(schema.taskSteps).where(eq(schema.taskSteps.id, fx.stepA));
          return token;
        },
      },
    ];

    it.each(cases)('answers 401 for $name and writes no row', async ({ arrange }) => {
      const token = await arrange();

      const res = await callTool('house_rules', { query: 'q' }, token);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: expect.any(String), code: 'invocation-not-live' });
      expect(await rowsFor()).toEqual([]);
      expect(h.searches).toEqual([]);
    });

    it('writes no row however often a stale token is replayed', async () => {
      expect((await callTool('house_rules', { query: 'q' })).status).toBe(200);
      await db
        .update(schema.cliInvocations)
        .set({ endedAt: new Date() })
        .where(eq(schema.cliInvocations.id, fx.invA));

      for (let i = 0; i < BUDGET + 10; i += 1) {
        expect((await callTool('house_rules', { query: 'q' })).status).toBe(401);
      }

      expect(await rowsFor(fx.invA)).toHaveLength(1);
    });

    it('answers 401 for an invocation that does not exist', async () => {
      const res = await callTool(
        'house_rules',
        { query: 'q' },
        mint({ cliInvocationId: randomUUID() }),
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: expect.any(String), code: 'invocation-not-live' });
      expect(await rowsFor()).toEqual([]);
      expect(h.searches).toEqual([]);
    });

    it('stops serving an invocation the moment it ends', async () => {
      expect((await callTool('house_rules', { query: 'q' })).status).toBe(200);
      await db
        .update(schema.cliInvocations)
        .set({ endedAt: new Date() })
        .where(eq(schema.cliInvocations.id, fx.invA));

      expect((await callTool('house_rules', { query: 'q' })).status).toBe(401);
    });
  });

  describe('the declared tool', () => {
    it.each([
      ['a name the step does not declare', { tool: 'nope', arguments: { query: 'q' } }],
      [
        'a tool that only the other step declares',
        { tool: 'beta_only', arguments: { query: 'q' } },
      ],
      ['a name in another case', { tool: 'House_Rules', arguments: { query: 'q' } }],
      ['an empty name', { tool: '', arguments: { query: 'q' } }],
      ['a name that is not a string', { tool: 5, arguments: { query: 'q' } }],
      ['no name', { arguments: { query: 'q' } }],
      ['a body that is not JSON', 'not json'],
      ['a body that is a JSON array', [{ tool: 'house_rules' }]],
    ])('answers 403 for %s, and records a refusal that names no tool', async (_name, body) => {
      const res = await send(body);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: expect.any(String), code: 'undeclared-tool' });
      await expectOneRow(fx.invA, refusedRow('undeclared-tool'));
      expect(h.searches).toEqual([]);
    });

    it('answers 403 to an invocation of a built-in step, which pins no prompt step', async () => {
      const token = mint({ taskStepId: fx.stepCore, cliInvocationId: fx.invCore });

      const res = await callTool('house_rules', { query: 'q' }, token);

      expect(res.status).toBe(403);
      await expectOneRow(
        fx.invCore,
        refusedRow('undeclared-tool', {
          task_step_id: fx.stepCore,
          cli_invocation_id: fx.invCore,
          step_id: STEP_CORE,
        }),
      );
    });

    it('serves the other step its own tool', async () => {
      const token = mint({ taskStepId: fx.stepB, cliInvocationId: fx.invB });

      const res = await callTool('beta_only', { query: 'q' }, token);

      expect(res.status).toBe(200);
      expect(h.searches).toEqual([{ taskId: fx.taskId, query: 'q', topK: 2 }]);
    });

    it.each([
      ['a task that pinned nothing', null],
      ['an entry that no longer parses', { [STEP_A]: { slug: 'alpha', tools: TOOLS_A } }],
      [
        'an entry filed under a step id its slug does not name',
        { [STEP_A]: entry('gamma', TOOLS_A) },
      ],
    ])('answers 403 for %s', async (_name, customSteps) => {
      await db.update(schema.tasks).set({ customSteps }).where(eq(schema.tasks.id, fx.taskId));

      const res = await callTool('house_rules', { query: 'q' });

      expect(res.status).toBe(403);
      await expectOneRow(fx.invA, refusedRow('undeclared-tool'));
    });

    it('reads the pin on every call: when the stored entry changes, so does what is served', async () => {
      expect((await callTool('house_rules', { query: 'q' })).status).toBe(200);
      await db
        .update(schema.tasks)
        .set({
          customSteps: { [STEP_A]: entry('alpha', [ragTool('only_this', 'global', 1, 1024)]) },
        })
        .where(eq(schema.tasks.id, fx.taskId));

      expect((await callTool('house_rules', { query: 'q' })).status).toBe(403);
      expect((await callTool('only_this', { query: 'q' })).status).toBe(200);
    });
  });

  describe('the order of the checks', () => {
    it('checks the liveness before the tool: an ended invocation naming an undeclared tool is 401', async () => {
      await db
        .update(schema.cliInvocations)
        .set({ endedAt: new Date() })
        .where(eq(schema.cliInvocations.id, fx.invA));

      expect((await callTool('nope')).status).toBe(401);
    });

    it('checks the tool before the switch: an undeclared tool is 403 undeclared-tool with the switch off', async () => {
      h.switchOn = false;

      const res = await callTool('nope');

      expect(await res.json()).toMatchObject({ code: 'undeclared-tool' });
    });

    it('checks the arguments before the action: an http-get call with bad arguments is 400', async () => {
      const res = await callTool('fetch_status', { page: 'x', extra: 1 });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid-arguments' });
    });
  });

  describe('the kill switch', () => {
    it('answers 403 switched-off with a refused row, and runs nothing', async () => {
      h.switchOn = false;

      const res = await callTool('house_rules', { query: 'q' });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: expect.any(String), code: 'switched-off' });
      await expectOneRow(
        fx.invA,
        refusedRow('switched-off', { tool: 'house_rules', action: 'rag-query' }),
      );
      expect(h.searches).toEqual([]);
    });

    it('serves again when it is switched back on', async () => {
      h.switchOn = false;
      expect((await callTool('house_rules', { query: 'q' })).status).toBe(403);
      h.switchOn = true;

      expect((await callTool('house_rules', { query: 'q' })).status).toBe(200);
    });

    it('reads on when the key was never set', async () => {
      h.switchOn = undefined;

      expect((await callTool('house_rules', { query: 'q' })).status).toBe(200);
    });
  });

  describe('the call budget', () => {
    it('is 50 per invocation, whatever the first 49 came to: the 50th is served and the 51st is 429 and writes nothing', async () => {
      for (let i = 0; i < 20; i += 1) {
        expect((await callTool('house_rules', { query: `q${i}` })).status).toBe(200);
      }
      for (let i = 0; i < 15; i += 1) {
        expect((await callTool('house_rules', { query: 'x', extra: i })).status).toBe(400);
      }
      for (let i = 0; i < 14; i += 1) expect((await callTool('nope')).status).toBe(403);
      expect(await rowsFor(fx.invA)).toHaveLength(BUDGET - 1);

      expect((await callTool('house_rules', { query: 'the last one' })).status).toBe(200);
      expect(await rowsFor(fx.invA)).toHaveLength(BUDGET);
      const res = await callTool('house_rules', { query: 'one more' });

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: expect.any(String), code: 'budget-spent' });
      const rows = await rowsFor(fx.invA);
      expect(rows).toHaveLength(BUDGET);
      expect(rows.filter((r) => r.outcome === 'ok')).toHaveLength(21);
      expect(h.searches).toHaveLength(21);
    });

    it('is counted per invocation: another invocation of the task is still served', async () => {
      for (let i = 0; i < BUDGET; i += 1) await callTool('house_rules', { query: 'q' });
      expect((await callTool('house_rules', { query: 'q' })).status).toBe(429);

      const other = mint({ taskStepId: fx.stepB, cliInvocationId: fx.invB });
      const res = await callTool('beta_only', { query: 'q' }, other);

      expect(res.status).toBe(200);
    });

    it('serves only the calls that fit when they arrive together: 49 spent, 8 at once, 1 served', async () => {
      await spendBudget(BUDGET - 1);
      h.search = async () => {
        await sleep(100);
        return [];
      };

      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, i) => callTool('house_rules', { query: `q${i}` })),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        200, 429, 429, 429, 429, 429, 429, 429,
      ]);
      expect(await rowsFor(fx.invA)).toHaveLength(BUDGET);
      expect(h.searches).toHaveLength(1);
    });

    it('takes the invocation lock before it counts: a claim waits while another holds the lock', async () => {
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holder = db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`custom-mcp-budget:${fx.invA}`}, 0))`,
        );
        held.resolve();
        await release.promise;
      });
      await held.promise;

      try {
        const call = callTool('house_rules', { query: 'q' });

        expect(await Promise.race([call, sleep(500).then(() => 'waiting')])).toBe('waiting');
        expect(await rowsFor(fx.invA)).toEqual([]);
        release.resolve();
        await holder;
        expect((await call).status).toBe(200);
      } finally {
        release.resolve();
        await holder;
      }
    });

    describe.each([
      ['an undeclared tool', 'nope', {}, true, 403],
      ['a tool that is switched off', 'house_rules', { query: 'q' }, false, 403],
      ['bad arguments', 'house_rules', { query: 'q', extra: 1 }, true, 400],
      ['an http-get tool', 'fetch_status', { page: 'x' }, true, 501],
    ])('a call refused for %s', (_name, tool, args, switchOn, status) => {
      it('stops adding rows at the budget: 60 of them leave 50, and the last 10 are 429', async () => {
        h.switchOn = switchOn;

        const statuses: number[] = [];
        for (let i = 0; i < BUDGET + 10; i += 1) statuses.push((await callTool(tool, args)).status);

        expect(statuses.filter((s) => s === status)).toHaveLength(BUDGET);
        expect(statuses.filter((s) => s === 429)).toHaveLength(10);
        expect(await rowsFor(fx.invA)).toHaveLength(BUDGET);
      });

      it('is answered 429 once the budget is spent, and writes nothing', async () => {
        await spendBudget();
        h.switchOn = switchOn;

        const res = await callTool(tool, args);

        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: expect.any(String), code: 'budget-spent' });
        expect(await rowsFor(fx.invA)).toHaveLength(BUDGET);
        expect(h.searches).toEqual([]);
      });
    });
  });

  describe('the arguments', () => {
    it.each([
      ['an argument the tool does not take', { query: 'q', extra: 1 }],
      ['a query of 501 characters', { query: 'x'.repeat(501) }],
      ['no query', {}],
      ['a query that is not a string', { query: 5 }],
      ['a query that is only blanks', { query: '   ' }],
      ['arguments that are a string', 'q'],
      ['arguments that are an array', ['q']],
    ])('answers 400 for %s and records a refusal against the tool', async (_name, args) => {
      const res = await callTool('house_rules', args);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.any(String), code: 'invalid-arguments' });
      await expectOneRow(
        fx.invA,
        refusedRow('invalid-arguments', { tool: 'house_rules', action: 'rag-query' }),
      );
      expect(h.searches).toEqual([]);
    });

    it('answers 400 when the arguments are left out of a tool that needs a query', async () => {
      const res = await callTool('house_rules');

      expect(res.status).toBe(400);
    });

    it('serves a query of exactly 500 characters', async () => {
      expect((await callTool('house_rules', { query: 'x'.repeat(500) })).status).toBe(200);
    });

    it.each([
      ['a parameter the tool does not take', { page: 'x', other: 1 }],
      ['a value over its maxLength', { page: 'x'.repeat(65) }],
      ['a missing required parameter', { verbose: true }],
      ['a value of the wrong type', { page: 'x', verbose: 'yes' }],
    ])('checks an http-get tool against its own parameters: %s is 400', async (_name, args) => {
      const res = await callTool('fetch_status', args);

      expect(res.status).toBe(400);
    });

    it('never puts what the agent sent into the refusal row', async () => {
      await callTool('house_rules', { query: QUERY_MARKER, [RESULT_MARKER]: 1 });

      expect(JSON.stringify(await rowsFor())).not.toContain(QUERY_MARKER);
      expect(JSON.stringify(await rowsFor())).not.toContain(RESULT_MARKER);
    });
  });

  describe('the body limit', () => {
    const body = (bytes: number): string => {
      const frame = JSON.stringify({ tool: 'house_rules', arguments: { query: 'q', pad: '' } });
      return JSON.stringify({
        tool: 'house_rules',
        arguments: { query: 'q', pad: 'x'.repeat(bytes - frame.length) },
      });
    };
    const framings: Array<[string, (text: string) => Record<string, string>]> = [
      ['streamed', () => ({})],
      ['with a Content-Length', (text) => ({ 'content-length': String(Buffer.byteLength(text)) })],
    ];

    describe.each(framings)('%s', (_framing, headers) => {
      it('lets a body of exactly 64 KiB through to the arguments check', async () => {
        const text = body(LIMIT);

        const res = await send(text, mint(), headers(text));

        expect(Buffer.byteLength(text)).toBe(LIMIT);
        expect(res.status).toBe(400);
      });

      it('answers 413 one byte past it, with a JSON error that names the limit, and writes no row', async () => {
        const text = body(LIMIT + 1);

        const res = await send(text, mint(), headers(text));

        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: expect.stringContaining('65536'), code: null });
        expect(await rowsFor()).toEqual([]);
        expect(h.searches).toEqual([]);
      });
    });

    it('answers 413 before the token is read', async () => {
      const res = await send(body(LIMIT + 1), null);

      expect(res.status).toBe(413);
    });
  });

  describe('rag-query', () => {
    const okBody = async (res: Response): Promise<{ ok: boolean; text: string }> =>
      (await res.json()) as { ok: boolean; text: string };

    it('answers 200 {ok, text} and records exactly one row, which holds neither the query nor the result', async () => {
      h.search = async () => [
        hit({ sourcePath: 'global_kb/rule.md', content: `rule ${RESULT_MARKER}`, scope: 'global' }),
      ];

      const res = await callTool('house_rules', { query: QUERY_MARKER });

      expect(res.status).toBe(200);
      const answer = await okBody(res);
      expect(answer.ok).toBe(true);
      expect(answer.text).toContain(RESULT_MARKER);
      expect(answer.text).toContain('[global] global_kb/rule.md');
      const row = await expectOneRow(fx.invA, {
        task_id: fx.taskId,
        task_step_id: fx.stepA,
        cli_invocation_id: fx.invA,
        step_id: STEP_A,
        tool: 'house_rules',
        action: 'rag-query',
        outcome: 'ok',
        reason: null,
        http_status: null,
        response_bytes: Buffer.byteLength(answer.text),
      });
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
      expect(typeof row.created_at).toBe('string');
      const dump = JSON.stringify(await rowsFor());
      expect(dump).not.toContain(QUERY_MARKER);
      expect(dump).not.toContain(RESULT_MARKER);
    });

    it('searches for the invocation task, with the query trimmed and the topK the tool declares', async () => {
      await callTool('house_rules', { query: '  padded  ' });
      await callTool('project_notes', { query: 'q' });

      expect(h.searches).toEqual([
        { taskId: fx.taskId, query: 'padded', topK: 3 },
        { taskId: fx.taskId, query: 'q', topK: 5 },
      ]);
    });

    it.each([
      ['project_notes', ['src/local.ts'], ['global_kb/rule.md']],
      ['house_rules', ['global_kb/rule.md'], ['src/local.ts']],
      ['everything', ['src/local.ts', 'global_kb/rule.md'], []],
    ])('keeps the hits of its scope: %s', async (tool, kept, dropped) => {
      h.search = async () => [
        hit({ sourcePath: 'src/local.ts', scope: 'local' }),
        hit({ sourcePath: 'global_kb/rule.md', scope: 'global' }),
      ];

      const answer = await okBody(await callTool(tool, { query: 'q' }));

      for (const path of kept) expect(answer.text).toContain(path);
      for (const path of dropped) expect(answer.text).not.toContain(path);
    });

    it('says so when nothing is left', async () => {
      h.search = async () => [hit({ scope: 'local' })];

      const res = await callTool('house_rules', { query: 'q' });

      expect(res.status).toBe(200);
      expect((await okBody(res)).text).toMatch(/^No results/);
      await expectOneRow(fx.invA, { outcome: 'ok', response_bytes: 11 });
    });

    it.each([['' as string], ['x']])(
      'cuts the text to maxResponseBytes on a character boundary (offset %j)',
      async (offset) => {
        h.search = async () => [
          hit({
            sourcePath: 'global_kb/big.md',
            content: `${offset}${'é'.repeat(5000)}`,
            scope: 'global',
          }),
        ];

        const answer = await okBody(await callTool('house_rules', { query: 'q' }));

        expect(Buffer.byteLength(answer.text)).toBeLessThanOrEqual(2048);
        expect(Buffer.byteLength(answer.text)).toBeGreaterThan(2000);
        expect(answer.text).not.toContain('�');
        expect(answer.text).toMatch(/\[truncated\]$/);
        await expectOneRow(fx.invA, { response_bytes: Buffer.byteLength(answer.text) });
      },
    );

    it('leaves a text under the cap whole', async () => {
      h.search = async () => [hit({ scope: 'global', content: 'short' })];

      const answer = await okBody(await callTool('house_rules', { query: 'q' }));

      expect(answer.text).not.toContain('[truncated]');
    });

    it('holds one running row while the search runs, then finishes that same row', async () => {
      const gate = Promise.withResolvers<unknown[]>();
      h.search = () => gate.promise;

      const call = callTool('house_rules', { query: 'q' });
      await vi.waitFor(() => expect(h.searches).toHaveLength(1), { timeout: 5000 });
      const during = await expectOneRow(fx.invA, {
        tool: 'house_rules',
        action: 'rag-query',
        outcome: 'running',
        reason: null,
        response_bytes: null,
      });
      gate.resolve([]);

      expect((await call).status).toBe(200);
      await expectOneRow(fx.invA, {
        id: during.id,
        outcome: 'ok',
        reason: null,
        response_bytes: 11,
      });
    });

    it('answers 500 action-failed when the search throws, finishes the row as error rather than running, and leaks nothing of the failure', async () => {
      h.search = async () => {
        throw new Error('connect ECONNREFUSED postgres://user:hunter2@store/db');
      };

      const res = await callTool('house_rules', { query: 'q' });

      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: expect.any(String), code: 'action-failed' });
      expect(text).not.toContain('hunter2');
      await expectOneRow(fx.invA, {
        outcome: 'error',
        reason: 'action-failed',
        tool: 'house_rules',
        action: 'rag-query',
        response_bytes: null,
      });
    });

    it('runs the real search for a task with no repository: no hits, and still one ok row', async () => {
      h.search = undefined;

      const res = await callTool('house_rules', { query: 'q' });

      expect(res.status).toBe(200);
      expect((await okBody(res)).text).toMatch(/^No results/);
      await expectOneRow(fx.invA, { outcome: 'ok', tool: 'house_rules' });
    });

    it('does not enter rag_query_log, which is the record of the haive-rag tool', async () => {
      await callTool('house_rules', { query: 'q' });

      const [logged] = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from rag_query_log where task_id = ${fx.taskId}`,
      );
      expect(logged!.n).toBe(0);
    });
  });

  describe('http-get', () => {
    it('answers 501 action-not-available with a refused row, and runs nothing', async () => {
      const res = await callTool('fetch_status', { page: 'summary', verbose: true });

      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: expect.any(String), code: 'action-not-available' });
      await expectOneRow(
        fx.invA,
        refusedRow('action-not-available', { tool: 'fetch_status', action: 'http-get' }),
      );
      expect(h.searches).toEqual([]);
    });
  });

  describe('the call log', () => {
    it('holds no argument, result or tool name an agent chose, across every kind of attempt', async () => {
      h.search = async () => [hit({ content: `found ${RESULT_MARKER}`, scope: 'global' })];
      await callTool(QUERY_MARKER, { query: QUERY_MARKER });
      await callTool('house_rules', { query: QUERY_MARKER, [QUERY_MARKER]: QUERY_MARKER });
      await callTool('house_rules', { query: QUERY_MARKER });
      await callTool('fetch_status', { page: QUERY_MARKER });
      await send(`{"tool":"${QUERY_MARKER}"`);

      const rows = await rowsFor();
      expect(rows.length).toBeGreaterThanOrEqual(4);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(COLUMNS);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(QUERY_MARKER);
      expect(dump).not.toContain(RESULT_MARKER);
    });

    it('is indexed for the budget count and the per-task listing', async () => {
      const indexes = await db.execute<{ indexdef: string }>(
        sql`select indexdef from pg_indexes where tablename = 'custom_tool_calls'`,
      );

      const defs = indexes.map((i) => i.indexdef);
      expect(defs.some((d) => d.includes('(cli_invocation_id)'))).toBe(true);
      expect(defs.some((d) => d.includes('(task_id, created_at)'))).toBe(true);
    });

    it('goes with its task, and stays when only its invocation or step goes', async () => {
      await callTool('house_rules', { query: 'q' });
      expect(await rowsFor()).toHaveLength(1);

      await db.delete(schema.cliInvocations).where(eq(schema.cliInvocations.id, fx.invA));
      expect(await rowsFor()).toEqual([expect.objectContaining({ cli_invocation_id: null })]);

      await db.delete(schema.taskSteps).where(eq(schema.taskSteps.id, fx.stepA));
      expect(await rowsFor()).toEqual([
        expect.objectContaining({
          task_id: fx.taskId,
          cli_invocation_id: null,
          task_step_id: null,
          step_id: STEP_A,
        }),
      ]);

      await db.delete(schema.tasks).where(eq(schema.tasks.id, fx.taskId));
      expect(await rowsFor()).toEqual([]);
    });
  });

  describe('the audience', () => {
    const custom = () => mint();

    it('keeps a custom-mcp token out of /rag/search', async () => {
      const res = await app.request('/rag/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${custom()}` },
        body: JSON.stringify({ query: 'q' }),
      });

      expect(res.status).toBe(401);
    });

    it.each(['status', 'logs', 'restart'])(
      'keeps a custom-mcp token out of /ddev/%s',
      async (action) => {
        const res = await app.request(`/ddev/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${custom()}` },
          body: '{}',
        });

        expect(res.status).toBe(401);
      },
    );
  });
});
