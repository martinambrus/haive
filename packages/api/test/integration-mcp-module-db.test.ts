import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.INTEGRATION_MCP_MODULE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integration_mcp_module_test'))
  throw new Error(
    'Use a dedicated integration_mcp_module_test database for the module executor route tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'trace';
  return { db: undefined as unknown, deadlineMs: 400 };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...actual,
    configService: {
      get: async () => null,
      getFresh: async () => null,
      getNumber: async (_key: string, fallback = 0) => fallback,
      getBoolean: async (_key: string, fallback = false) => fallback,
    },
  };
});
vi.mock('../src/lib/integration-call-limits.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  INTEGRATION_CALL_DEADLINE_MS: h.deadlineMs,
}));

import {
  encrypt,
  encryptDek,
  generateDek,
  generateEncryptionKey,
  logger,
  secretsService,
} from '@haive/shared';
import { encryptConnectionTokens } from '@haive/shared/integrations';
import { signTaskToken, type TaskTokenClaims } from '@haive/shared/task-token';
import { createApiApp } from '../src/index.js';
import { mountModules } from '../src/modules/loader.js';
import * as fx from './support/module-executors-fixture.js';
import {
  createVendorStub,
  defaultReply,
  json,
  networkFailure,
  reflecting,
} from './support/vendor-fetch-stub.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const KEK = generateEncryptionKey();
const SECRET = `stub${randomUUID()}`;
const USER_PREFIX = 'integration-mcp-module-test-';
const BUDGET = 50;
const LIST = '/integration-mcp/tools/list';
const CALL = '/integration-mcp/call';
const MARKER = '\n[truncated]';
const TEXT_LIMIT = 65_536;
const GET = 'get_doc';
const APPEND = 'append_doc';
const FETCH = 'fetch_url';
const BIG = 'big';
const LEAK = 'leak';
const FORGE_GET = 'get_pull_request_state';

type Row = Record<string, unknown>;
type Access = 'read' | 'write';
type Binding = NonNullable<(typeof schema.cliInvocations.$inferInsert)['integrations']>[number];
type Listed = { name: string; description: string; inputSchema: Record<string, unknown> };

const READ: Row = { tool: GET, access: 'read' };
const WRITE: Row = { tool: APPEND, access: 'write' };
const FETCHING: Row = { tool: FETCH, access: 'read' };

interface World {
  userId: string;
  connectionId: string;
  taskId: string;
  stepId: string;
  invocationId: string;
  token: string;
  refresh: string;
  label: string;
  externalId: string | null;
}

const { stub, hang, stallBody } = createVendorStub();

const logs: string[] = [];

function captureLogs(): void {
  const key = Object.getOwnPropertySymbols(logger).find(
    (symbol) => symbol.description === 'pino.stream',
  );
  if (!key) throw new Error('the shared logger exposes no pino stream to capture');
  const stream = (logger as unknown as Record<symbol, { write: (chunk: unknown) => unknown }>)[
    key
  ]!;
  const write = stream.write.bind(stream);
  stream.write = (chunk) => {
    logs.push(String(chunk));
    return write(chunk);
  };
}

const texts = new WeakMap<Response, string>();
const textOf = (res: Response): string => texts.get(res) ?? '';
const bodyOf = (res: Response): unknown => {
  try {
    return JSON.parse(textOf(res));
  } catch {
    return textOf(res);
  }
};

describe.skipIf(!url)(
  'module provider executors behind the integration broker, on Postgres',
  () => {
    let db: Database;
    let app: ReturnType<typeof createApiApp>;
    let ownerId: string;
    let otherId: string;
    const secrets: string[] = [];
    const accessTokens: string[] = [];
    const bodies: string[] = [];

    async function createUser(): Promise<string> {
      const [user] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: 'integration-mcp-module-test@test.local',
          emailBlindIndex: `${USER_PREFIX}${randomUUID()}`,
          passwordHash: 'not-real',
        })
        .returning({ id: schema.users.id });
      return user!.id;
    }

    async function createConnection(
      userId: string,
      over: {
        providerId?: string;
        token?: string;
        label?: string;
        externalId?: string | null;
        scope?: 'user' | 'shared';
        status?: 'connected' | 'needs_reauth' | 'revoked';
      } = {},
    ): Promise<{
      id: string;
      token: string;
      refresh: string;
      label: string;
      externalId: string | null;
    }> {
      const token = over.token ?? `stubtok${randomUUID()}`;
      const refresh = `stubref${randomUUID()}`;
      const label = over.label ?? `account-${randomUUID().slice(0, 8)}`;
      const externalId = over.externalId === undefined ? `ext-${randomUUID()}` : over.externalId;
      secrets.push(token, refresh);
      accessTokens.push(token);
      const [connection] = await db
        .insert(schema.integrationConnections)
        .values({
          providerId: over.providerId ?? fx.FX_PROVIDER,
          scope: over.scope ?? 'user',
          ownerUserId: userId,
          accountLabel: label,
          externalAccountId: externalId,
          authMethod: 'device',
          grantedScopes: ['docs.read', 'docs.write'],
          ...encryptConnectionTokens({ accessToken: token, refreshToken: refresh }, KEK),
          expiresAt: new Date(Date.now() + 3_600_000),
          status: over.status ?? 'connected',
        })
        .returning({ id: schema.integrationConnections.id });
      return { id: connection!.id, token, refresh, label, externalId };
    }

    async function createTask(userId: string): Promise<string> {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: null,
          type: 'workflow',
          title: 'integration mcp module',
          status: 'running',
        })
        .returning({ id: schema.tasks.id });
      return task!.id;
    }

    async function createStep(taskId: string, stepId = '07-implement'): Promise<string> {
      const [step] = await db
        .insert(schema.taskSteps)
        .values({ taskId, stepId, stepIndex: 1, title: stepId, status: 'waiting_cli' })
        .returning({ id: schema.taskSteps.id });
      return step!.id;
    }

    async function createInvocation(
      taskId: string,
      taskStepId: string,
      stamp: Binding[] | null,
    ): Promise<string> {
      const [invocation] = await db
        .insert(schema.cliInvocations)
        .values({ taskId, taskStepId, mode: 'cli', prompt: 'p', integrations: stamp })
        .returning({ id: schema.cliInvocations.id });
      return invocation!.id;
    }

    const binding = (
      connectionId: string,
      access: Access,
      over: Partial<Binding> = {},
    ): Binding => ({
      requirementId: 'docs',
      categoryId: fx.FX_CATEGORY,
      providerId: fx.FX_PROVIDER,
      connectionId,
      access,
      ...over,
    });

    const setStamp = (w: World, stamp: unknown) =>
      db
        .update(schema.cliInvocations)
        .set({ integrations: stamp as Binding[] | null })
        .where(eq(schema.cliInvocations.id, w.invocationId));

    const setSwitch = (userId: string, writeEnabled: boolean, providerId = fx.FX_PROVIDER) =>
      db
        .insert(schema.integrationUserSettings)
        .values({ userId, providerId, writeEnabled })
        .onConflictDoUpdate({
          target: [
            schema.integrationUserSettings.userId,
            schema.integrationUserSettings.providerId,
          ],
          set: { writeEnabled },
        });

    const setConfig = (providerId: string, enabled: boolean) =>
      db
        .insert(schema.integrationProviderConfigs)
        .values({ providerId, enabled })
        .onConflictDoUpdate({
          target: schema.integrationProviderConfigs.providerId,
          set: { enabled },
        });

    const setModule = (moduleId: string, deactivated: boolean) =>
      db
        .insert(schema.modules)
        .values({
          moduleId,
          packageName: `@haive/module-${moduleId}`,
          name: `Module ${moduleId}`,
          installedVersion: '1.0.0',
          deactivatedAt: deactivated ? new Date() : null,
        })
        .onConflictDoUpdate({
          target: schema.modules.moduleId,
          set: { deactivatedAt: deactivated ? new Date() : null },
        });

    async function seed(
      opts: {
        userId?: string;
        access?: Access;
        writeSwitch?: boolean;
        token?: string;
        externalId?: string | null;
      } = {},
    ): Promise<World> {
      const userId = opts.userId ?? ownerId;
      const connection = await createConnection(userId, {
        ...(opts.token === undefined ? {} : { token: opts.token }),
        ...(opts.externalId === undefined ? {} : { externalId: opts.externalId }),
      });
      if (opts.writeSwitch !== undefined) await setSwitch(userId, opts.writeSwitch);
      const taskId = await createTask(userId);
      const stepId = await createStep(taskId);
      const invocationId = await createInvocation(taskId, stepId, [
        binding(connection.id, opts.access ?? 'read'),
      ]);
      return {
        userId,
        connectionId: connection.id,
        taskId,
        stepId,
        invocationId,
        token: connection.token,
        refresh: connection.refresh,
        label: connection.label,
        externalId: connection.externalId,
      };
    }

    const mint = (w: World, claims: Partial<TaskTokenClaims> = {}): string =>
      signTaskToken(
        {
          aud: 'integrations',
          taskId: w.taskId,
          taskStepId: w.stepId,
          cliInvocationId: w.invocationId,
          ...claims,
        },
        SECRET,
      );

    async function send(path: string, body: unknown, token: string | null): Promise<Response> {
      const res = await app.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await res.clone().text();
      texts.set(res, text);
      bodies.push(text, [...res.headers].map(([name, value]) => `${name}: ${value}`).join('\n'));
      return res;
    }

    const list = (w: World) => send(LIST, {}, mint(w));
    const call = (w: World, tool: unknown, args?: unknown) =>
      send(CALL, { tool, ...(args === undefined ? {} : { arguments: args }) }, mint(w));

    const rows = async (): Promise<Row[]> => [
      ...(await db.execute<Row>(sql`select * from integration_calls order by created_at, id`)),
    ];

    const rowOf = (w: World, over: Row): Row => ({
      connection_id: w.connectionId,
      provider_id: fx.FX_PROVIDER,
      task_id: w.taskId,
      task_step_id: w.stepId,
      cli_invocation_id: w.invocationId,
      surface: 'rest',
      ...over,
    });

    async function expectOneRow(w: World, over: Row): Promise<Row> {
      const found = await rows();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject(rowOf(w, over));
      return found[0]!;
    }

    function expectError(res: Response, status: number, code: string): void {
      expect(res.status, textOf(res)).toBe(status);
      expect(bodyOf(res), textOf(res)).toEqual({ error: expect.any(String), code });
    }

    async function expectRefusal(
      w: World,
      res: Response,
      status: number,
      code: string,
      op: Row = READ,
    ): Promise<void> {
      expectError(res, status, code);
      await expectOneRow(w, { ...op, outcome: 'refused', reason: code });
      expect(stub.calls).toEqual([]);
      expect(fx.state.entered, 'the executor ran').toBe(0);
    }

    async function expectNoTrace(): Promise<void> {
      expect(await rows()).toEqual([]);
      expect(stub.calls).toEqual([]);
    }

    function servedText(res: Response): string {
      expect(res.status, textOf(res)).toBe(200);
      const body = bodyOf(res) as { ok?: unknown; text?: unknown };
      expect(Object.keys(body).sort()).toEqual(['ok', 'text']);
      expect(body.ok).toBe(true);
      expect(typeof body.text).toBe('string');
      return body.text as string;
    }
    const served = (res: Response): Record<string, unknown> =>
      JSON.parse(servedText(res)) as Record<string, unknown>;

    function listed(res: Response): Listed[] {
      expect(res.status, textOf(res)).toBe(200);
      const body = bodyOf(res) as { tools?: Listed[] };
      expect(Object.keys(body)).toEqual(['tools']);
      return body.tools!;
    }
    const namesOf = (res: Response): string[] =>
      listed(res)
        .map((tool) => tool.name)
        .sort();

    async function answeredWithin(ms: number, pending: Promise<Response>): Promise<Response> {
      const settled = await Promise.race([pending, sleep(ms).then(() => null)]);
      if (settled === null) {
        stub.release();
        pending.catch(() => undefined);
        throw new Error(`no answer within ${ms} ms`);
      }
      return settled;
    }

    async function spendRows(w: World, count: number): Promise<void> {
      const outcomes = ['ok', 'refused', 'error'] as const;
      await db.insert(schema.integrationCalls).values(
        Array.from({ length: count }, (_, i) => ({
          connectionId: w.connectionId,
          providerId: fx.FX_PROVIDER,
          taskId: w.taskId,
          taskStepId: w.stepId,
          cliInvocationId: w.invocationId,
          tool: GET,
          access: 'read' as const,
          surface: 'rest' as const,
          outcome: outcomes[i % outcomes.length]!,
          reason: i % outcomes.length === 0 ? null : 'vendor-error',
        })),
      );
    }

    async function leakSites(secret: string): Promise<string[]> {
      const found: string[] = [];
      if (bodies.some((text) => text.includes(secret))) found.push('a response body or header');
      if (JSON.stringify(await rows()).includes(secret)) found.push('an integration_calls row');
      if (logs.some((line) => line.includes(secret))) found.push('a log line');
      return found;
    }

    const forms = (token: string): string[] => [
      token,
      Buffer.from(token).toString('base64'),
      Buffer.from(token).toString('base64url'),
      Buffer.from(token).toString('hex'),
    ];

    async function clean(): Promise<void> {
      await db.delete(schema.integrationCalls);
      await db.delete(schema.integrationProviderConfigs);
      await db.delete(schema.modules);
      await db.delete(schema.users).where(like(schema.users.emailBlindIndex, `${USER_PREFIX}%`));
    }

    beforeAll(async () => {
      db = createDatabase(url as string);
      h.db = db;
      app = createApiApp('http://localhost:3000');
      captureLogs();
      await clean();
    });

    afterAll(async () => {
      await mountModules(app, [], { db });
      await clean();
      await db.$client.end({ timeout: 5 });
    });

    beforeEach(async () => {
      vi.stubEnv('CONFIG_ENCRYPTION_KEY', SECRET);
      vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
      vi.stubGlobal('fetch', stub.fetch);
      stub.reset();
      fx.resetFixture();
      logs.length = 0;
      bodies.length = 0;
      secrets.length = 0;
      accessTokens.length = 0;
      await clean();
      ownerId = await createUser();
      otherId = await createUser();
      await setConfig(fx.FX_PROVIDER, true);
      await mountModules(app, [fx.fxEntry()], { db });
    });

    afterEach(async () => {
      try {
        fx.state.onEntered = null;
        fx.state.gate = null;
        const released = stub.release();
        if (released > 0) await sleep(100);
        const attempted = stub.calls.map((c) => `${c.method} ${c.url}`);
        expect(
          stub.calls.filter((c) => !c.hasSignal).map((c) => c.url),
          'vendor requests sent without init.signal',
        ).toEqual([]);
        expect(
          stub.calls.filter((c) => c.redirect !== 'error').map((c) => c.url),
          'vendor requests sent without redirect: error',
        ).toEqual([]);
        expect(
          stub.calls.filter((c) => new URL(c.url).origin !== fx.FX_BASE).map((c) => c.url),
          `vendor requests to a host other than ${fx.FX_HOST} (all: ${attempted.join(', ')})`,
        ).toEqual([]);
        expect(
          stub.calls
            .filter(
              (c) => !accessTokens.some((token) => c.headers.authorization === `Bearer ${token}`),
            )
            .map((c) => `${c.url} authorization=${c.headers.authorization}`),
          'vendor requests whose Authorization is not exactly Bearer <an access token of this test>',
        ).toEqual([]);
        const running = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from integration_calls where outcome = 'running'`,
        );
        expect(running[0]!.n, 'rows still running once the answer was sent').toBe(0);
        for (const secret of secrets) {
          expect(await leakSites(secret), 'where a token leaked').toEqual([]);
        }
        for (const made of fx.state.calls) {
          expect(
            fx.findInValue(made.call, secrets.flatMap(forms)),
            `a token in the call object of ${made.opId}`,
          ).toEqual([]);
        }
      } finally {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });

    describe('X1 the tool list of a module provider', () => {
      it.each([[true], [false]])(
        '[X1] lists the read operations alone for a read binding when the write switch is %s (PIN)',
        async (on) => {
          const w = await seed({ access: 'read', writeSwitch: on });

          expect(namesOf(await list(w))).toEqual(fx.READ_OPS);
          await expectNoTrace();
        },
      );

      it('[X1] lists the read operations alone for a write binding when the owner has no switch row (PIN)', async () => {
        const w = await seed({ access: 'write' });

        expect(namesOf(await list(w))).toEqual(fx.READ_OPS);
        await expectNoTrace();
      });

      it('[X1] lists the read operations alone for a write binding whose switch is off (PIN)', async () => {
        const w = await seed({ access: 'write', writeSwitch: false });

        expect(namesOf(await list(w))).toEqual(fx.READ_OPS);
        await expectNoTrace();
      });

      it('[X1] does not take another user, or another provider, for the owner switch (PIN)', async () => {
        const w = await seed({ access: 'write' });
        await setSwitch(otherId, true);
        await setSwitch(ownerId, true, 'github');

        expect(namesOf(await list(w))).toEqual(fx.READ_OPS);
        await expectNoTrace();
      });

      it('[X1] lists append_doc with the others for a write binding whose switch is on, as {name, description, inputSchema} from the manifest, and writes no row (PIN)', async () => {
        const w = await seed({ access: 'write', writeSwitch: true });

        const tools = listed(await list(w));

        expect(tools.map((tool) => tool.name).sort()).toEqual(fx.ALL_OPS);
        for (const tool of tools) {
          expect(Object.keys(tool).sort()).toEqual(['description', 'inputSchema', 'name']);
          const declared = fx.FX_OPERATIONS.find((op) => op.opId === tool.name)!;
          expect(tool.description).toBe(declared.description);
          expect(tool.inputSchema).toEqual(declared.inputSchema);
        }
        await expectNoTrace();
      });
    });

    describe('X2 a call runs the executor through the vendor client', () => {
      it('[X2] answers {ok, text} with the JSON of the result, and records one ok row', async () => {
        const w = await seed();

        const result = served(await call(w, GET, { docId: 'd1' }));

        expect(result).toEqual({ id: 'd1', view: 'summary', title: 'Doc d1', status: 200 });
        await expectOneRow(w, { ...READ, outcome: 'ok', reason: null });
      });

      it('[X2] sends one GET to the vendor with the Bearer of the connection, redirect error and a signal', async () => {
        const w = await seed();

        served(await call(w, GET, { docId: 'd1' }));

        expect(stub.calls).toHaveLength(1);
        const made = stub.calls[0]!;
        const target = new URL(made.url);
        expect(made.method).toBe('GET');
        expect(`${target.origin}${target.pathname}`).toBe(`${fx.FX_BASE}/v1/docs/d1`);
        expect(target.searchParams.get('view')).toBe('summary');
        expect(made.headers.authorization).toBe(`Bearer ${w.token}`);
        expect(made.redirect).toBe('error');
        expect(made.hasSignal).toBe(true);
      });

      it('[X2] hands the executor the arguments as the schema parsed them: the default is applied', async () => {
        const w = await seed();

        served(await call(w, GET, { docId: 'd1' }));
        served(await call(w, GET, { docId: 'd2', view: 'full' }));

        expect(fx.state.calls.map((made) => made.call.args)).toEqual([
          { docId: 'd1', view: 'summary' },
          { docId: 'd2', view: 'full' },
        ]);
      });

      it('[X2] hands the executor a call of args, vendor, signal and account, the account being the connection', async () => {
        const w = await seed();

        served(await call(w, GET, { docId: 'd1' }));

        const made = fx.state.calls[0]!.call;
        expect(Object.keys(made).sort()).toEqual(['account', 'args', 'signal', 'vendor']);
        expect(made.account).toEqual({ label: w.label, externalAccountId: w.externalId });
        expect(made.signal).toBeInstanceOf(AbortSignal);
        expect(typeof made.vendor.request).toBe('function');
      });

      it('[X2+] hands the executor a null external account id when the connection has none', async () => {
        const w = await seed({ externalId: null });

        served(await call(w, GET, { docId: 'd1' }));

        expect(fx.state.calls[0]!.call.account).toEqual({
          label: w.label,
          externalAccountId: null,
        });
      });

      it('[X2] writes the running row before the executor runs, and finishes it ok', async () => {
        const w = await seed();
        const held = fx.holdExecutor();
        const pending = call(w, GET, { docId: 'd1' });

        const first = await Promise.race([
          held.entered.then(() => 'entered'),
          pending.then(() => 'answered'),
        ]);
        if (first !== 'entered') expect(first, textOf(await pending)).toBe('entered');
        const during = await rows();
        held.release();
        served(await pending);

        expect(during).toHaveLength(1);
        expect(during[0]).toMatchObject(rowOf(w, { ...READ, outcome: 'running', reason: null }));
        await expectOneRow(w, { ...READ, outcome: 'ok', reason: null });
      });

      it('[X2+] append_doc POSTs the arguments to the vendor as JSON, and records one ok write row', async () => {
        const w = await seed({ access: 'write', writeSwitch: true });

        const result = served(await call(w, APPEND, { docId: 'd1', text: 'hello' }));

        expect(result).toEqual({ id: 'd1', appended: true, length: 5 });
        expect(stub.calls).toHaveLength(1);
        const made = stub.calls[0]!;
        expect(made.method).toBe('POST');
        expect(made.url).toBe(`${fx.FX_BASE}/v1/docs/d1/append`);
        expect(JSON.parse(made.body!)).toEqual({ text: 'hello' });
        expect(made.headers['content-type']).toMatch(/^application\/json/);
        expect(made.headers.authorization).toBe(`Bearer ${w.token}`);
        await expectOneRow(w, { ...WRITE, outcome: 'ok', reason: null });
      });

      it.each([
        ['an owner with no switch row', undefined],
        ['an owner whose switch is off', false],
      ])(
        '[X2+] refuses append_doc, which the write binding declares, for %s, with write-switched-off',
        async (_name, writeSwitch) => {
          const w = await seed({
            access: 'write',
            ...(writeSwitch === undefined ? {} : { writeSwitch }),
          });
          expect(namesOf(await list(w))).toEqual(fx.READ_OPS);

          const res = await call(w, APPEND, { docId: 'd1', text: 'hello' });

          await expectRefusal(w, res, 403, 'write-switched-off', WRITE);
        },
      );

      it('[X2] never lets a caller-supplied authorization header reach the vendor: the vendor sees the connection token alone', async () => {
        const w = await seed();

        const result = served(
          await call(w, FETCH, {
            url: `${fx.FX_BASE}/v1/docs/d1`,
            headers: {
              authorization: 'Bearer attacker-one',
              Authorization: 'Bearer attacker-two',
              'x-trace': 'abc',
            },
          }),
        );

        expect(result).toMatchObject({ status: 200 });
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]!.headers.authorization).toBe(`Bearer ${w.token}`);
        expect(JSON.stringify(stub.calls[0]!.headers)).not.toContain('attacker');
      });

      it('[X2+] passes the other headers an executor sets on to the vendor, beside the connection token', async () => {
        const w = await seed();

        served(await call(w, GET, { docId: 'd1' }));
        served(
          await call(w, FETCH, { url: `${fx.FX_BASE}/v1/docs/d2`, headers: { 'x-trace': 'abc' } }),
        );

        expect(stub.calls).toHaveLength(2);
        expect(stub.calls[0]!.headers.accept).toBe('application/json');
        expect(stub.calls[1]!.headers['x-trace']).toBe('abc');
        for (const made of stub.calls) expect(made.headers.authorization).toBe(`Bearer ${w.token}`);
      });

      it('[X2] resolves the vendor answer as {status, body}: parsed JSON for a JSON content type, the text otherwise', async () => {
        const w = await seed();

        const plain = served(await call(w, FETCH, { url: `${fx.FX_BASE}/v1/json` }));
        const charset = served(await call(w, FETCH, { url: `${fx.FX_BASE}/v1/json-utf8` }));
        const words = served(await call(w, FETCH, { url: `${fx.FX_BASE}/v1/text` }));

        expect(plain).toEqual({ status: 200, body: { a: 1 } });
        expect(charset).toEqual({ status: 200, body: { a: 2 } });
        expect(words).toEqual({ status: 200, body: 'hello' });
      });

      it('[X2+] counts a module call against the same 50-call budget: the 50th is served, the 51st is 429 with no row and no vendor call', async () => {
        const w = await seed();
        await spendRows(w, BUDGET - 1);

        served(await call(w, GET, { docId: 'd1' }));
        expect(await rows()).toHaveLength(BUDGET);
        const res = await call(w, GET, { docId: 'd2' });

        expectError(res, 429, 'budget-spent');
        expect(await rows()).toHaveLength(BUDGET);
        expect(stub.calls).toHaveLength(1);
      });
    });

    describe('X3 the token of THAT connection', () => {
      it('[X3] sends the token of the caller alone: A, then B, then A again', async () => {
        const a = await seed({ userId: ownerId });
        const b = await seed({ userId: otherId });

        served(await call(a, GET, { docId: 'a1' }));
        served(await call(b, GET, { docId: 'b1' }));
        served(await call(a, GET, { docId: 'a2' }));

        expect(
          stub.calls.map((made) => [new URL(made.url).pathname, made.headers.authorization]),
        ).toEqual([
          ['/v1/docs/a1', `Bearer ${a.token}`],
          ['/v1/docs/b1', `Bearer ${b.token}`],
          ['/v1/docs/a2', `Bearer ${a.token}`],
        ]);
        const found = await rows();
        expect(found.map((row) => [row.connection_id, row.task_id])).toEqual([
          [a.connectionId, a.taskId],
          [b.connectionId, b.taskId],
          [a.connectionId, a.taskId],
        ]);
      });

      it('[X3+] keeps every token with its own call while the calls of both users overlap', async () => {
        const a = await seed({ userId: ownerId });
        const b = await seed({ userId: otherId });
        stub.respond = async (made, init) => {
          await sleep(5 + (made.url.length % 7) * 6);
          return defaultReply(made, init);
        };

        const answers = await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            call(i % 2 === 0 ? a : b, GET, { docId: `${i % 2 === 0 ? 'a' : 'b'}${i}` }),
          ),
        );

        for (const res of answers) served(res);
        expect(stub.calls).toHaveLength(16);
        for (const made of stub.calls) {
          const owner = new URL(made.url).pathname.startsWith('/v1/docs/a') ? a : b;
          expect(made.headers.authorization, made.url).toBe(`Bearer ${owner.token}`);
        }
      });

      it('[X3+] sends each call to its own connection when one user holds two accounts of the provider', async () => {
        const first = await seed({ userId: ownerId });
        const second = await createConnection(ownerId);
        await setStamp(first, [
          binding(first.connectionId, 'read', { requirementId: 'work' }),
          binding(second.id, 'read', { requirementId: 'home' }),
        ]);

        expect(namesOf(await list(first))).toEqual(
          [
            ...fx.READ_OPS.map((op) => `work_${op}`),
            ...fx.READ_OPS.map((op) => `home_${op}`),
          ].sort(),
        );
        served(await call(first, 'home_get_doc', { docId: 'h1' }));
        served(await call(first, 'work_get_doc', { docId: 'w1' }));

        expect(stub.calls.map((made) => made.headers.authorization)).toEqual([
          `Bearer ${second.token}`,
          `Bearer ${first.token}`,
        ]);
        expect((await rows()).map((row) => [row.tool, row.connection_id])).toEqual([
          ['home_get_doc', second.id],
          ['work_get_doc', first.connectionId],
        ]);
        expect(fx.state.calls.map((made) => made.call.account.label)).toEqual([
          second.label,
          first.label,
        ]);
      });

      it('[X3+] answers 403 connection-unavailable, and sends nothing, when the stamp names a connection of another user', async () => {
        const w = await seed();
        const theirs = await createConnection(otherId);
        await setStamp(w, [binding(theirs.id, 'read')]);

        await expectRefusal(w, await call(w, GET, { docId: 'd1' }), 403, 'connection-unavailable', {
          ...READ,
          connection_id: theirs.id,
        });
      });

      it.each(['needs_reauth', 'revoked'] as const)(
        '[X3+] answers 403 connection-unavailable for a connection whose status is %s',
        async (status) => {
          const w = await seed();
          await db
            .update(schema.integrationConnections)
            .set({ status })
            .where(eq(schema.integrationConnections.id, w.connectionId));

          await expectRefusal(
            w,
            await call(w, GET, { docId: 'd1' }),
            403,
            'connection-unavailable',
          );
        },
      );

      it.each([
        ["the task owner's", () => ownerId],
        ["another user's", () => otherId],
      ])(
        '[X3+] answers 403 connection-unavailable for a shared connection that is %s',
        async (_name, ownerOf) => {
          const w = await seed();
          const shared = await createConnection(ownerOf(), { scope: 'shared' });
          await setStamp(w, [binding(shared.id, 'read')]);

          await expectRefusal(
            w,
            await call(w, GET, { docId: 'd1' }),
            403,
            'connection-unavailable',
            {
              ...READ,
              connection_id: shared.id,
            },
          );
        },
      );

      it('[X3+] answers 403 connection-unavailable, with a row that names no connection, once the connection is gone', async () => {
        const w = await seed();
        await db
          .delete(schema.integrationConnections)
          .where(eq(schema.integrationConnections.id, w.connectionId));

        await expectRefusal(w, await call(w, GET, { docId: 'd1' }), 403, 'connection-unavailable', {
          ...READ,
          connection_id: null,
        });
      });
    });

    describe('X4 the arguments are parsed before anything runs', () => {
      const badGets: Array<[string, unknown]> = [
        ['no docId', {}],
        ['an empty docId', { docId: '' }],
        ['a docId of 65 characters', { docId: 'd'.repeat(65) }],
        ['a docId that is a number', { docId: 5 }],
        ['an extra key', { docId: 'd1', extra: true }],
        ['a view the schema does not list', { docId: 'd1', view: 'raw' }],
        ['arguments that are a string', 'd1'],
        ['arguments that are a list', ['d1']],
        ['arguments that are null', null],
      ];

      it.each(badGets)(
        '[X4] answers 400 invalid-arguments for %s, with one refused row, no vendor request and no executor run',
        async (_name, args) => {
          const w = await seed();

          await expectRefusal(w, await call(w, GET, args), 400, 'invalid-arguments');
        },
      );

      it('[X4] answers 400 invalid-arguments when the arguments are left out', async () => {
        const w = await seed();

        await expectRefusal(w, await call(w, GET), 400, 'invalid-arguments');
      });

      it.each([
        ['no text', { docId: 'd1' }],
        ['an empty text', { docId: 'd1', text: '' }],
        ['a text of 2001 characters', { docId: 'd1', text: 't'.repeat(2001) }],
      ])(
        '[X4+] answers 400 invalid-arguments for append_doc with %s, with one refused write row',
        async (_name, args) => {
          const w = await seed({ access: 'write', writeSwitch: true });

          await expectRefusal(w, await call(w, APPEND, args), 400, 'invalid-arguments', WRITE);
        },
      );

      it('[X4+] serves the same call once the arguments are right', async () => {
        const w = await seed();
        await expectRefusal(w, await call(w, GET, { docId: '' }), 400, 'invalid-arguments');
        await db.delete(schema.integrationCalls);

        served(await call(w, GET, { docId: 'd'.repeat(64) }));

        expect(stub.calls).toHaveLength(1);
        expect(fx.state.entered).toBe(1);
      });
    });

    describe('X5 the vendor client refuses before it sends', () => {
      const REFUSED = { ...FETCHING, outcome: 'error', reason: 'vendor-host-refused' };
      const refusedTargets: Array<[string, string]> = [
        ['a host that is not in apiHosts', 'https://evil.example.test/'],
        ['a plain http url of the listed host', 'http://docs.example.test/'],
      ];

      it.each(refusedTargets)(
        '[X5] refuses %s with vendor-host-refused: 502, one error row, no request',
        async (_name, target) => {
          const w = await seed();

          const res = await call(w, FETCH, { url: target });

          expectError(res, 502, 'vendor-host-refused');
          await expectOneRow(w, REFUSED);
          expect(stub.calls).toEqual([]);
        },
      );

      it('[X5] refuses a 302 from the listed host with vendor-redirect-refused: one request, redirect error, nothing sent on', async () => {
        const w = await seed();

        const res = await call(w, FETCH, { url: `${fx.FX_BASE}/redirect` });

        expectError(res, 502, 'vendor-redirect-refused');
        await expectOneRow(w, { ...FETCHING, outcome: 'error', reason: 'vendor-redirect-refused' });
        expect(stub.calls.map((made) => [made.method, made.url, made.redirect])).toEqual([
          ['GET', `${fx.FX_BASE}/redirect`, 'error'],
        ]);
      });

      it.each([301, 303, 307, 308])('[X5+] refuses a %i the same way', async (status) => {
        const w = await seed();

        const res = await call(w, FETCH, { url: `${fx.FX_BASE}/moved/${status}` });

        expectError(res, 502, 'vendor-redirect-refused');
        expect(stub.calls).toHaveLength(1);
      });

      it('[X5+] refuses a redirect to the listed host itself', async () => {
        const w = await seed();

        const res = await call(w, FETCH, { url: `${fx.FX_BASE}/old` });

        expectError(res, 502, 'vendor-redirect-refused');
        await expectOneRow(w, { ...FETCHING, outcome: 'error', reason: 'vendor-redirect-refused' });
        expect(stub.calls).toHaveLength(1);
      });

      it('[X5+] serves a url of the listed host, so the refusals above are not a client that sends nothing', async () => {
        const w = await seed();

        const result = served(await call(w, FETCH, { url: `${fx.FX_BASE}/v1/docs/ok` }));

        expect(result).toMatchObject({ status: 200, body: { id: 'ok' } });
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]!.headers.authorization).toBe(`Bearer ${w.token}`);
      });

      const hostile: Array<[string, string]> = [
        ['a suffix lookalike', 'https://evildocs.example.test/'],
        ['the listed host as a prefix of another', 'https://docs.example.test.evil.example.test/'],
        ['a subdomain of the listed host', 'https://sub.docs.example.test/'],
        ['the listed host as userinfo', 'https://docs.example.test@evil.example.test/'],
        ['the listed host in the path', 'https://evil.example.test/docs.example.test'],
        ['the listed host in the query', 'https://evil.example.test/?host=docs.example.test'],
        ['the listed host in the fragment', 'https://evil.example.test/#docs.example.test'],
        ['loopback by name', 'https://localhost/'],
        ['loopback by address', 'https://127.0.0.1/'],
        ['loopback in IPv6', 'https://[::1]/'],
        ['a link-local metadata address', 'https://169.254.169.254/latest/meta-data/'],
        ['ftp', 'ftp://docs.example.test/'],
        ['a websocket url', 'wss://docs.example.test/'],
        ['a file url', 'file:///etc/passwd'],
        ['a javascript url', 'javascript:alert(1)'],
      ];

      it.each(hostile)(
        '[X5+] refuses %s with vendor-host-refused, and sends nothing',
        async (_name, target) => {
          const w = await seed();

          const res = await call(w, FETCH, { url: target });

          expectError(res, 502, 'vendor-host-refused');
          await expectOneRow(w, REFUSED);
          expect(stub.calls).toEqual([]);
        },
      );

      it.each([
        ['a path with no host', '/v1/docs/d1'],
        ['a host with no scheme', 'docs.example.test/v1/docs/d1'],
        ['a protocol-relative url', '//docs.example.test/v1/docs/d1'],
        ['a scheme and nothing else', 'https://'],
        ['text that is no url', 'not a url'],
      ])('[X5+] fails %s as an error row, and sends nothing', async (_name, target) => {
        const w = await seed();

        const res = await call(w, FETCH, { url: target });

        expect(res.status, textOf(res)).toBeGreaterThanOrEqual(400);
        expect(
          (await rows()).map((row) => row.outcome),
          textOf(res),
        ).toEqual(['error']);
        expect(stub.calls).toEqual([]);
      });

      it('[X5] across a battery of hostile urls and a redirect, no request carrying a token reaches any host but docs.example.test', async () => {
        const w = await seed();
        const battery = [
          ...refusedTargets.map(([, target]) => target),
          ...hostile.map(([, target]) => target),
          `${fx.FX_BASE}/redirect`,
          `${fx.FX_BASE}/moved/307`,
        ];

        const answers: string[] = [];
        for (const target of battery) answers.push(textOf(await call(w, FETCH, { url: target })));

        expect(
          stub.calls.map((made) => made.url),
          `answers: ${answers.slice(0, 3).join(' ')}`,
        ).toEqual([`${fx.FX_BASE}/redirect`, `${fx.FX_BASE}/moved/307`]);
        for (const made of stub.calls) {
          expect(new URL(made.url).hostname).toBe(fx.FX_HOST);
          expect(made.hop).toBe(false);
        }
      });
    });

    describe('X6 what the vendor answers', () => {
      const statuses: Array<[number, string]> = [
        [401, 'vendor-auth'],
        [403, 'vendor-auth'],
        [404, 'vendor-not-found'],
        [409, 'vendor-conflict'],
        [422, 'vendor-conflict'],
        [429, 'vendor-rate-limited'],
        [500, 'vendor-error'],
      ];

      it.each(statuses)(
        '[X6] answers 502 for a vendor %i as %s, with one error row',
        async (status, code) => {
          const w = await seed();
          stub.respond = reflecting(status);

          const res = await call(w, GET, { docId: 'd1' });

          expectError(res, 502, code);
          await expectOneRow(w, { ...READ, outcome: 'error', reason: code });
          expect(stub.calls).toHaveLength(1);
        },
      );

      it.each([400, 402, 418, 502, 503])(
        '[X6] answers 502 vendor-error for any other non-2xx status, %i among them',
        async (status) => {
          const w = await seed();
          stub.respond = reflecting(status);

          const res = await call(w, GET, { docId: 'd1' });

          expectError(res, 502, 'vendor-error');
          await expectOneRow(w, { ...READ, outcome: 'error', reason: 'vendor-error' });
        },
      );

      it('[X6] answers 502 vendor-error when the connection to the vendor fails', async () => {
        const w = await seed();
        stub.respond = () => Promise.reject(networkFailure());

        const res = await call(w, GET, { docId: 'd1' });

        expectError(res, 502, 'vendor-error');
        await expectOneRow(w, { ...READ, outcome: 'error', reason: 'vendor-error' });
        expect(stub.calls).toHaveLength(1);
      });

      const hangs: Array<[string, string, (init: RequestInit) => Promise<Response> | Response]> = [
        ['X6', 'never answers', hang],
        ['X6+', 'sends its headers and stalls the body', stallBody],
      ];

      it.each(hangs)(
        '[%s] answers 504 timeout within the deadline + 2 s when the vendor %s, with one error row',
        async (_tag, _name, respond) => {
          const w = await seed();
          stub.respond = (_made, init) => respond(init);
          const started = Date.now();

          const res = await answeredWithin(h.deadlineMs + 2000, call(w, GET, { docId: 'd1' }));

          expect(Date.now() - started).toBeLessThan(h.deadlineMs + 2000);
          expectError(res, 504, 'timeout');
          await expectOneRow(w, { ...READ, outcome: 'error', reason: 'timeout' });
          expect(stub.calls).toHaveLength(1);
          expect(stub.calls[0]!.abortedAt, 'the deadline must abort init.signal').not.toBeNull();
          expect(fx.state.calls[0]!.call.signal.aborted, 'call.signal is the broker deadline').toBe(
            true,
          );
        },
      );
    });

    describe('X7 the result text is bounded', () => {
      const textOfBig = async (args: Record<string, unknown>) => {
        const w = await seed();
        const text = servedText(await call(w, BIG, args));
        return { w, text };
      };

      it('[X7] cuts a result of 200000 bytes to at most 65536 UTF-8 bytes ending \\n[truncated], and records one ok row', async () => {
        const { w, text } = await textOfBig({});

        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TEXT_LIMIT);
        expect(text.endsWith(MARKER)).toBe(true);
        await expectOneRow(w, { tool: BIG, access: 'read', outcome: 'ok', reason: null });
      });

      it('[X7+] keeps the start of the result: what is left before the marker is a prefix of the JSON', async () => {
        const { text } = await textOfBig({ bytes: 200_000 });

        const kept = text.slice(0, -MARKER.length);
        expect(kept.length).toBeGreaterThan(TEXT_LIMIT / 2);
        expect(JSON.stringify(fx.sizedResult(200_000)).startsWith(kept)).toBe(true);
      });

      it('[X7] counts bytes, not characters: a result of 3-byte characters is cut to 65536 bytes too', async () => {
        const { text } = await textOfBig({ bytes: 300_010, multibyte: true });

        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TEXT_LIMIT);
        expect(text.endsWith(MARKER)).toBe(true);
        expect(text.includes('€')).toBe(true);
      });

      it('[X7+] does not end in a cut character', async () => {
        const { text } = await textOfBig({ bytes: 300_010, multibyte: true });

        expect(text.includes('�')).toBe(false);
      });

      it('[X7+] leaves a result of exactly 65536 bytes whole, with no marker', async () => {
        const { text } = await textOfBig({ bytes: TEXT_LIMIT });

        expect(text).toBe(JSON.stringify(fx.sizedResult(TEXT_LIMIT)));
        expect(Buffer.byteLength(text)).toBe(TEXT_LIMIT);
      });

      it('[X7+] cuts a result of 65537 bytes', async () => {
        const { text } = await textOfBig({ bytes: TEXT_LIMIT + 1 });

        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TEXT_LIMIT);
        expect(text.endsWith(MARKER)).toBe(true);
      });

      it('[X7+] leaves a small result alone', async () => {
        const w = await seed();

        const text = servedText(await call(w, GET, { docId: 'd1' }));

        expect(text.endsWith(MARKER)).toBe(false);
        expect(JSON.parse(text)).toEqual({
          id: 'd1',
          view: 'summary',
          title: 'Doc d1',
          status: 200,
        });
      });
    });

    describe('X8 the state of the provider', () => {
      it('[X8] answers 403 provider-deactivated, with one refused row, no request and no executor run, once the module is deactivated', async () => {
        const w = await seed();
        await setModule(fx.FX_MODULE_ID, true);

        await expectRefusal(w, await call(w, GET, { docId: 'd1' }), 403, 'provider-deactivated');
      });

      it('[X8+] reads the deactivation on every call: reactivating the module serves the same call again', async () => {
        const w = await seed();
        await setModule(fx.FX_MODULE_ID, true);
        expectError(await call(w, GET, { docId: 'd1' }), 403, 'provider-deactivated');
        await setModule(fx.FX_MODULE_ID, false);

        served(await call(w, GET, { docId: 'd2' }));

        expect((await rows()).map((row) => [row.outcome, row.reason])).toEqual([
          ['refused', 'provider-deactivated'],
          ['ok', null],
        ]);
        expect(stub.calls).toHaveLength(1);
      });

      describe('a stamp naming a provider of a module that is gone', () => {
        async function goneWorld(): Promise<World> {
          const connection = await createConnection(ownerId, { providerId: fx.GONE_PROVIDER });
          await setConfig(fx.GONE_PROVIDER, true);
          const taskId = await createTask(ownerId);
          const stepId = await createStep(taskId);
          const invocationId = await createInvocation(taskId, stepId, [
            binding(connection.id, 'read', {
              categoryId: fx.GONE_CATEGORY,
              providerId: fx.GONE_PROVIDER,
            }),
          ]);
          return {
            userId: ownerId,
            connectionId: connection.id,
            taskId,
            stepId,
            invocationId,
            token: connection.token,
            refresh: connection.refresh,
            label: connection.label,
            externalId: connection.externalId,
          };
        }

        it('[X8] is answered 403 provider-missing, with one refused row, no request and no executor run', async () => {
          const w = await goneWorld();

          const res = await call(w, GET, { docId: 'd1' });

          expectError(res, 403, 'provider-missing');
          const found = await rows();
          expect(found).toHaveLength(1);
          expect(found[0]).toMatchObject({
            provider_id: fx.GONE_PROVIDER,
            cli_invocation_id: w.invocationId,
            surface: 'rest',
            outcome: 'refused',
            reason: 'provider-missing',
          });
          expect(stub.calls).toEqual([]);
          expect(fx.state.entered).toBe(0);
        });

        it('[X8+] leaves the tools of a provider that is there alone: the list holds them, and a call is served', async () => {
          const w = await seed();
          const gone = await createConnection(ownerId, { providerId: fx.GONE_PROVIDER });
          await setStamp(w, [
            binding(w.connectionId, 'read'),
            binding(gone.id, 'read', {
              requirementId: 'old',
              categoryId: fx.GONE_CATEGORY,
              providerId: fx.GONE_PROVIDER,
            }),
          ]);

          expect(namesOf(await list(w))).toEqual(fx.READ_OPS);
          served(await call(w, GET, { docId: 'd1' }));

          expect(stub.calls).toHaveLength(1);
          expect(stub.calls[0]!.headers.authorization).toBe(`Bearer ${w.token}`);
        });
      });

      it('[X8] refuses a provider the admin switches off with provider-unavailable, and serves it again once it is switched back on', async () => {
        const w = await seed();
        served(await call(w, GET, { docId: 'd1' }));
        await setConfig(fx.FX_PROVIDER, false);

        const refused = await call(w, GET, { docId: 'd2' });

        expectError(refused, 403, 'provider-unavailable');
        await setConfig(fx.FX_PROVIDER, true);
        served(await call(w, GET, { docId: 'd3' }));
        expect((await rows()).map((row) => [row.outcome, row.reason])).toEqual([
          ['ok', null],
          ['refused', 'provider-unavailable'],
          ['ok', null],
        ]);
        expect(stub.calls).toHaveLength(2);
      });

      it('[X8+] treats a module provider no admin has switched on as off: provider-unavailable (PIN)', async () => {
        const w = await seed();
        await db.delete(schema.integrationProviderConfigs);

        await expectRefusal(w, await call(w, GET, { docId: 'd1' }), 403, 'provider-unavailable');
      });

      it('[X8] answers 403 provider-unavailable for a forge provider the admin has switched off (PIN)', async () => {
        const secret = `stub${randomUUID()}`;
        secrets.push(secret);
        const dek = generateDek();
        const [credential] = await db
          .insert(schema.repoCredentials)
          .values({
            userId: ownerId,
            label: `credential ${randomUUID()}`,
            host: 'github.com',
            provider: 'github',
            apiBaseUrl: null,
            usernameEncrypted: encrypt('octocat', dek),
            secretEncrypted: encrypt(secret, dek),
            encryptedDek: encryptDek(dek, KEK),
          })
          .returning({ id: schema.repoCredentials.id });
        const [connection] = await db
          .insert(schema.integrationConnections)
          .values({
            providerId: 'github',
            scope: 'user',
            ownerUserId: ownerId,
            accountLabel: 'octocat',
            authMethod: 'token',
            repoCredentialId: credential!.id,
          })
          .returning({ id: schema.integrationConnections.id });
        const [repository] = await db
          .insert(schema.repositories)
          .values({
            userId: ownerId,
            name: `repo ${randomUUID()}`,
            source: 'git_https',
            remoteUrl: 'https://github.com/acme/widgets.git',
          })
          .returning({ id: schema.repositories.id });
        const [task] = await db
          .insert(schema.tasks)
          .values({
            userId: ownerId,
            repositoryId: repository!.id,
            type: 'workflow',
            title: 'integration mcp module',
            status: 'running',
          })
          .returning({ id: schema.tasks.id });
        const stepId = await createStep(task!.id);
        const invocationId = await createInvocation(task!.id, stepId, [
          binding(connection!.id, 'read', {
            requirementId: 'forge',
            categoryId: 'forge',
            providerId: 'github',
          }),
        ]);
        await setConfig('github', false);
        const w: World = {
          userId: ownerId,
          connectionId: connection!.id,
          taskId: task!.id,
          stepId,
          invocationId,
          token: secret,
          refresh: secret,
          label: 'octocat',
          externalId: null,
        };

        const res = await call(w, FORGE_GET, { prNumber: '42' });

        expectError(res, 403, 'provider-unavailable');
        const found = await rows();
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
          provider_id: 'github',
          outcome: 'refused',
          reason: 'provider-unavailable',
        });
        expect(stub.calls).toEqual([]);
      });
    });

    describe('X12 the access token never leaves the api', () => {
      it('[X12] reaches the vendor in Authorization and nowhere else: no response, no row, no log line holds it, whatever the vendor echoes', async () => {
        const w = await seed({ access: 'write', writeSwitch: true });

        served(await call(w, GET, { docId: 'd1' }));
        await list(w);
        expectError(await call(w, GET, { docId: '' }), 400, 'invalid-arguments');
        for (const status of [401, 403, 404, 409, 422, 429, 500]) {
          stub.respond = reflecting(status);
          expect((await call(w, GET, { docId: 'd1' })).status).toBe(502);
        }
        stub.respond = reflecting(500);
        expect((await call(w, APPEND, { docId: 'd1', text: 'hello' })).status).toBe(502);
        stub.respond = defaultReply;
        served(await call(w, APPEND, { docId: 'd1', text: 'hello' }));

        expect(stub.calls.length).toBeGreaterThanOrEqual(9);
        for (const made of stub.calls) {
          expect(made.headers.authorization).toBe(`Bearer ${w.token}`);
        }
        expect(
          logs.some((line) => line.includes(`"path":"${CALL}"`)),
          'the log capture must see the request log',
        ).toBe(true);
        expect(await leakSites(w.token)).toEqual([]);
        expect(await leakSites(w.refresh)).toEqual([]);
      });

      it('[X12] delivers the error text of an executor that holds the token redacted: the call fails and no token is in a response, a row or a log line', async () => {
        const w = await seed();
        fx.state.leakText = w.token;
        fx.state.secrets = forms(w.token);

        const res = await call(w, LEAK, {});

        expect(res.status, textOf(res)).toBeGreaterThanOrEqual(400);
        const found = await rows();
        expect(
          found.map((row) => [row.tool, row.outcome]),
          `answer ${textOf(res)}, reasons ${JSON.stringify(found.map((row) => row.reason))}`,
        ).toEqual([[LEAK, 'error']]);
        expect(typeof found[0]!.reason).toBe('string');
        expect(fx.state.entered).toBe(1);
        expect(await leakSites(w.token)).toEqual([]);
        expect(await leakSites(w.refresh)).toEqual([]);
      });

      it('[X12] finds no token in the call object an executor receives, however deep it is looked for', async () => {
        const w = await seed({ access: 'write', writeSwitch: true });
        fx.state.secrets = forms(w.token);

        served(await call(w, GET, { docId: 'd1' }));
        served(await call(w, APPEND, { docId: 'd1', text: 'hello' }));

        expect(fx.state.calls).toHaveLength(2);
        for (const made of fx.state.calls) {
          expect(fx.findInValue(made.call, [...forms(w.token), ...forms(w.refresh)])).toEqual([]);
        }
      });

      it('[X12+] keeps every part of a long token out of an echo that an error cut would split', async () => {
        const long = `stub${randomUUID()}${'q'.repeat(560)}`;
        const w = await seed({ token: long });
        stub.respond = (made) =>
          json(401, { pad: 'p'.repeat(60), received: made.headers.authorization });

        expectError(await call(w, GET, { docId: 'd1' }), 502, 'vendor-auth');

        const windows = Array.from({ length: long.length - 11 }, (_, i) => long.slice(i, i + 12));
        const seen = [...bodies, JSON.stringify(await rows()), ...logs];
        expect(windows.filter((piece) => seen.some((text) => text.includes(piece)))).toEqual([]);
      });
    });
  },
);
