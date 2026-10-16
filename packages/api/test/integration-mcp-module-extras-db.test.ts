import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.INTEGRATION_MCP_MODULE_EXTRAS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integration_mcp_module_extras_test'))
  throw new Error(
    'Use a dedicated integration_mcp_module_extras_test database for the module route extras tests',
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
import { signTaskToken } from '@haive/shared/task-token';
import { createApiApp } from '../src/index.js';
import { mountModules } from '../src/modules/loader.js';
import * as fx from './support/module-executors-fixture.js';
import { createVendorStub, defaultReply, json, text } from './support/vendor-fetch-stub.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const KEK = generateEncryptionKey();
const SECRET = `stub${randomUUID()}`;
const USER_PREFIX = 'imcp-module-extras-';
const CALL = '/integration-mcp/call';
const GET = 'get_doc';
const APPEND = 'append_doc';
const FETCH = 'fetch_url';
const LEAK = 'leak';
const FORGE_GET = 'get_pull_request_state';
const FORGE_OPEN = 'open_pull_request';
const FORGE_OPEN_ARGS = { head: 'feature/x', base: 'main', title: 'Add x', body: 'Adds x.' };
const GITHUB_REMOTE = 'https://github.com/acme/widgets.git';
const TOKEN_HOST = `login.${fx.FX_HOST}`;

type Row = Record<string, unknown>;
type Access = 'read' | 'write';
type Binding = NonNullable<(typeof schema.cliInvocations.$inferInsert)['integrations']>[number];

interface World {
  connectionId: string;
  taskId: string;
  stepId: string;
  invocationId: string;
  token: string;
  providerId: string;
}

const { stub } = createVendorStub();

// What the platform does and the stub does not: a signal that is already aborted sends nothing.
const abortAwareFetch = ((input: string | URL | Request, init?: RequestInit) =>
  init?.signal?.aborted
    ? Promise.reject(init.signal.reason)
    : stub.fetch(input, init)) as typeof fetch;

const lowerEscapes = (value: string) =>
  value.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());

// How a vendor's encoder may write a token that holds + / =.
const spellingsOf = (token: string): Array<[string, string]> => [
  ['as it is', token],
  ['PHP-escaped', token.replaceAll('/', '\\/')],
  ['.NET-escaped', token.replaceAll('+', '\\u002B')],
  ['upper-case percent-encoded', encodeURIComponent(token)],
  ['lower-case percent-encoded', lowerEscapes(encodeURIComponent(token))],
];
const SPELLINGS = spellingsOf('a+b/c=').map(([name]) => name);
const echoOf = (name: string, token: string): string =>
  spellingsOf(token).find(([spelling]) => spelling === name)![1];
const newToken = () => `tok+${randomUUID()}/end==`;
// A JSON string doubles a backslash, so a leak is looked for with backslashes taken out of both sides.
const bare = (value: string) => value.replaceAll('\\', '');

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
const bodyOf = (res: Response): Record<string, unknown> => {
  try {
    return JSON.parse(textOf(res)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

describe.skipIf(!url)('the module route extras of the integration broker, on Postgres', () => {
  let db: Database;
  let app: ReturnType<typeof createApiApp>;
  let ownerId: string;
  const bodies: string[] = [];

  async function createUser(): Promise<string> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'integration-mcp-module-extras-test@test.local',
        emailBlindIndex: `${USER_PREFIX}${randomUUID()}`,
        passwordHash: 'not-real',
      })
      .returning({ id: schema.users.id });
    return user!.id;
  }

  const bindingOf = (
    connectionId: string,
    access: Access,
    providerId = fx.FX_PROVIDER,
    categoryId = fx.FX_CATEGORY,
  ): Binding => ({ requirementId: 'docs', categoryId, providerId, connectionId, access });

  async function createRun(
    connectionId: string,
    repositoryId: string | null,
    stamp: Binding[],
  ): Promise<Omit<World, 'token' | 'providerId'>> {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: ownerId,
        repositoryId,
        type: 'workflow',
        title: 'integration mcp module extras',
        status: 'running',
      })
      .returning({ id: schema.tasks.id });
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '07-implement',
        stepIndex: 1,
        title: 's',
        status: 'waiting_cli',
      })
      .returning({ id: schema.taskSteps.id });
    const [invocation] = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: task!.id,
        taskStepId: step!.id,
        mode: 'cli',
        prompt: 'p',
        integrations: stamp,
      })
      .returning({ id: schema.cliInvocations.id });
    return {
      connectionId,
      taskId: task!.id,
      stepId: step!.id,
      invocationId: invocation!.id,
    };
  }

  async function seed(
    opts: {
      token?: string;
      expired?: boolean;
      access?: Access;
      writeSwitch?: boolean;
      stamp?: (connectionId: string) => Binding[];
    } = {},
  ): Promise<World> {
    const token = opts.token ?? `stubtok${randomUUID()}`;
    const [connection] = await db
      .insert(schema.integrationConnections)
      .values({
        providerId: fx.FX_PROVIDER,
        scope: 'user',
        ownerUserId: ownerId,
        accountLabel: 'acct',
        externalAccountId: `ext-${randomUUID()}`,
        authMethod: 'device',
        grantedScopes: ['docs.read', 'docs.write'],
        ...encryptConnectionTokens({ accessToken: token, refreshToken: `ref${randomUUID()}` }, KEK),
        expiresAt: new Date(Date.now() + (opts.expired ? -3_600_000 : 3_600_000)),
        status: 'connected',
      })
      .returning({ id: schema.integrationConnections.id });
    if (opts.writeSwitch !== undefined) {
      await db.insert(schema.integrationUserSettings).values({
        userId: ownerId,
        providerId: fx.FX_PROVIDER,
        writeEnabled: opts.writeSwitch,
      });
    }
    const stamp = opts.stamp?.(connection!.id) ?? [
      bindingOf(connection!.id, opts.access ?? 'read'),
    ];
    return {
      ...(await createRun(connection!.id, null, stamp)),
      token,
      providerId: fx.FX_PROVIDER,
    };
  }

  async function seedForge(secret: string, access: Access = 'read'): Promise<World> {
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
        remoteUrl: GITHUB_REMOTE,
      })
      .returning({ id: schema.repositories.id });
    if (access === 'write') {
      await db
        .insert(schema.integrationUserSettings)
        .values({ userId: ownerId, providerId: 'github', writeEnabled: true });
    }
    const stamp: Binding[] = [
      {
        requirementId: 'forge',
        categoryId: 'forge',
        providerId: 'github',
        connectionId: connection!.id,
        access,
      },
    ];
    return {
      ...(await createRun(connection!.id, repository!.id, stamp)),
      token: secret,
      providerId: 'github',
    };
  }

  async function mountWith(opId: string, run: fx.FixtureExecutor['run']): Promise<void> {
    const executors = fx.fxExecutors();
    executors[fx.FX_PROVIDER]![opId]!.run = run;
    await mountModules(app, [fx.fxEntry({ executors })], { db });
  }

  const mint = (w: World): string =>
    signTaskToken(
      {
        aud: 'integrations',
        taskId: w.taskId,
        taskStepId: w.stepId,
        cliInvocationId: w.invocationId,
      },
      SECRET,
    );

  async function call(w: World, tool: string, args?: unknown): Promise<Response> {
    const res = await app.request(CALL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mint(w)}` },
      body: JSON.stringify({ tool, ...(args === undefined ? {} : { arguments: args }) }),
    });
    const body = await res.clone().text();
    texts.set(res, body);
    bodies.push(body);
    return res;
  }

  const rows = async (): Promise<Row[]> => [
    ...(await db.execute<Row>(sql`select * from integration_calls order by created_at, id`)),
  ];

  async function expectOneRow(w: World, over: Row): Promise<void> {
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      connection_id: w.connectionId,
      provider_id: w.providerId,
      task_id: w.taskId,
      task_step_id: w.stepId,
      cli_invocation_id: w.invocationId,
      surface: 'rest',
      ...over,
    });
  }

  function expectError(res: Response, status: number, code: string): void {
    expect(res.status, textOf(res)).toBe(status);
    expect(bodyOf(res), textOf(res)).toEqual({ error: expect.any(String), code });
  }

  function servedText(res: Response): string {
    expect(res.status, textOf(res)).toBe(200);
    const body = bodyOf(res);
    expect(Object.keys(body).sort()).toEqual(['ok', 'text']);
    expect(body.ok).toBe(true);
    return body.text as string;
  }

  async function answeredWithin(ms: number, pending: Promise<Response>): Promise<Response> {
    const settled = await Promise.race([pending, sleep(ms).then(() => null)]);
    if (settled === null) {
      pending.catch(() => undefined);
      throw new Error(`no answer within ${ms} ms`);
    }
    return settled;
  }

  async function leakSites(token: string): Promise<string[]> {
    const found: string[] = [];
    const stored = bare(JSON.stringify(await rows()));
    for (const [name, spelling] of spellingsOf(token)) {
      const needle = bare(spelling);
      if (bodies.some((body) => bare(body).includes(needle))) found.push(`a response, ${name}`);
      if (stored.includes(needle)) found.push(`an integration_calls row, ${name}`);
      if (logs.some((line) => bare(line).includes(needle))) found.push(`a log line, ${name}`);
    }
    return found;
  }

  async function clean(): Promise<void> {
    await db.delete(schema.integrationCalls);
    await db.delete(schema.integrationProviderConfigs);
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
    vi.stubGlobal('fetch', abortAwareFetch);
    stub.reset();
    fx.resetFixture();
    logs.length = 0;
    bodies.length = 0;
    await clean();
    ownerId = await createUser();
    await db.insert(schema.integrationProviderConfigs).values({
      providerId: fx.FX_PROVIDER,
      enabled: true,
    });
    await mountModules(app, [fx.fxEntry()], { db });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const running = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from integration_calls where outcome = 'running'`,
    );
    expect(running[0]!.n, 'rows still running once the answer was sent').toBe(0);
  });

  describe('what a module call answers beyond the vendor and the arguments', () => {
    it('removes the token from a successful answer the vendor echoes it in', async () => {
      const w = await seed();
      stub.respond = (made) => json(200, { title: `echo ${made.headers.authorization}` });

      const res = await call(w, GET, { docId: 'd1' });

      expect(servedText(res)).not.toContain(w.token);
      expect(servedText(res)).toContain('[redacted]');
      await expectOneRow(w, { tool: GET, access: 'read', outcome: 'ok', reason: null });
    });

    it.each([
      ['no OAuth client is configured for the provider', undefined],
      ['the vendor refuses the refresh', 'client-1'],
    ])(
      'answers an expired token that cannot be renewed, because %s, as connection-unavailable with a refused row and no request to the api',
      async (_name, oauthClientId) => {
        if (oauthClientId !== undefined) {
          await db
            .update(schema.integrationProviderConfigs)
            .set({ oauthClientId })
            .where(eq(schema.integrationProviderConfigs.providerId, fx.FX_PROVIDER));
        }
        stub.respond = (made, init) =>
          new URL(made.url).hostname === TOKEN_HOST
            ? json(400, { error: 'invalid_request' })
            : defaultReply(made, init);
        const w = await seed({ expired: true });

        const res = await call(w, GET, { docId: 'd1' });

        expectError(res, 403, 'connection-unavailable');
        expect(bodyOf(res).error).toBe('the access token could not be renewed');
        await expectOneRow(w, {
          tool: GET,
          access: 'read',
          outcome: 'refused',
          reason: 'connection-unavailable',
        });
        expect(stub.calls.filter((made) => new URL(made.url).hostname === fx.FX_HOST)).toEqual([]);
        expect(stub.calls.length).toBe(oauthClientId === undefined ? 0 : 1);
      },
    );

    it('answers an executor that returns nothing with the text null', async () => {
      await mountWith(GET, async () => undefined);
      const w = await seed();

      const res = await call(w, GET, { docId: 'd1' });

      expect(servedText(res)).toBe('null');
      await expectOneRow(w, { tool: GET, outcome: 'ok', reason: null });
    });

    it('stores no tool name the agent chose for a call to a provider no module declares', async () => {
      const w = await seed({
        stamp: (connectionId) => [
          bindingOf(connectionId, 'write', fx.GONE_PROVIDER, fx.GONE_CATEGORY),
        ],
      });
      w.providerId = fx.GONE_PROVIDER;

      const res = await call(w, `agent-chosen-${'x'.repeat(500)}`, {});

      expectError(res, 403, 'provider-missing');
      expect(bodyOf(res).error).toContain(fx.GONE_PROVIDER);
      await expectOneRow(w, {
        tool: '',
        access: 'write',
        outcome: 'refused',
        reason: 'provider-missing',
      });
    });
  });

  describe('the deadline of a call', () => {
    const WITHIN = h.deadlineMs + 2000;

    it('answers 504 timeout, with one error row, for an executor that never settles and ignores its signal', async () => {
      await mountWith(GET, () => new Promise<never>(() => undefined));
      const w = await seed();
      const started = Date.now();

      const res = await answeredWithin(WITHIN, call(w, GET, { docId: 'd1' }));

      expect(Date.now() - started).toBeLessThan(WITHIN);
      expectError(res, 504, 'timeout');
      await expectOneRow(w, { tool: GET, outcome: 'error', reason: 'timeout' });
      expect(stub.calls).toEqual([]);
    });

    it('sends nothing to the vendor for an executor that settles after the answer was sent', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let report: (outcome: string) => void = () => undefined;
      const afterwards = new Promise<string>((resolve) => {
        report = resolve;
      });
      let seen: AbortSignal | undefined;
      await mountWith(GET, async (made) => {
        seen = made.signal;
        await gate;
        await made.vendor.request({ method: 'GET', url: `${fx.FX_BASE}/v1/docs/late` }).then(
          () => report('sent'),
          () => report('refused'),
        );
        return { id: 'late' };
      });
      const w = await seed();

      const res = await answeredWithin(WITHIN, call(w, GET, { docId: 'd1' }));
      expectError(res, 504, 'timeout');
      release();

      expect(await afterwards).toBe('refused');
      expect(seen?.aborted).toBe(true);
      expect(stub.calls).toEqual([]);
      await expectOneRow(w, { tool: GET, outcome: 'error', reason: 'timeout' });
    });

    it('sends nothing to the vendor from a request an executor left behind when it returned', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let left: Promise<string> = Promise.resolve('never ran');
      await mountWith(GET, async (made) => {
        left = gate
          .then(() => made.vendor.request({ method: 'GET', url: `${fx.FX_BASE}/v1/docs/left` }))
          .then(
            () => 'sent',
            () => 'refused',
          );
        return { id: 'd1' };
      });
      const w = await seed();

      const res = await call(w, GET, { docId: 'd1' });
      expect(servedText(res)).toBe('{"id":"d1"}');
      release();

      expect(await left).toBe('refused');
      expect(stub.calls).toEqual([]);
      await expectOneRow(w, { tool: GET, outcome: 'ok', reason: null });
    });
  });

  describe('the token the vendor or the executor echoes, in every way it can be written', () => {
    it.each(SPELLINGS)(
      'removes the token from the error text of a module call when the vendor echoes it %s',
      async (name) => {
        const token = newToken();
        const echo = echoOf(name, token);
        const w = await seed({ token });
        stub.respond = () =>
          text(400, `{"received":"${echo}","message":"Bad credentials"}`, 'application/json');

        const res = await call(w, GET, { docId: 'd1' });

        expectError(res, 502, 'vendor-error');
        expect(bodyOf(res).error).toContain('[redacted]');
        expect(await leakSites(token)).toEqual([]);
      },
    );

    it.each(SPELLINGS)(
      'removes the token from the text of a module call whose executor returns what the vendor echoed %s',
      async (name) => {
        const token = newToken();
        const echo = echoOf(name, token);
        const w = await seed({ token });
        stub.respond = () => text(200, `note ${echo} end`);

        const res = await call(w, FETCH, { url: `${fx.FX_BASE}/v1/note` });

        expect(servedText(res)).toBe(JSON.stringify({ status: 200, body: 'note [redacted] end' }));
        expect(await leakSites(token)).toEqual([]);
      },
    );

    it.each(SPELLINGS)(
      'removes the token from the log detail of a module executor that fails with it %s',
      async (name) => {
        const token = newToken();
        const echo = echoOf(name, token);
        const w = await seed({ token });
        fx.state.leakText = echo;

        const res = await call(w, LEAK, {});

        expectError(res, 500, 'internal-error');
        expect(
          logs.some((line) => line.includes('an integration call failed unexpectedly')),
          'the log capture must see the failure',
        ).toBe(true);
        expect(await leakSites(token)).toEqual([]);
      },
    );

    it.each(SPELLINGS)(
      'removes the token from the error text of a forge call when the vendor echoes it %s',
      async (name) => {
        const secret = newToken();
        const echo = echoOf(name, secret);
        const w = await seedForge(secret);
        stub.respond = () =>
          text(401, `{"received":"${echo}","message":"Bad credentials"}`, 'application/json');

        const res = await call(w, FORGE_GET, { prNumber: '42' });

        expectError(res, 502, 'vendor-auth');
        expect(bodyOf(res).error).toContain('[redacted]');
        expect(await leakSites(secret)).toEqual([]);
      },
    );

    it.each(SPELLINGS)(
      'removes the token from the whole text of a forge call the vendor answered with it %s, and cuts nothing',
      async (name) => {
        const secret = newToken();
        const echo = echoOf(name, secret);
        const w = await seedForge(secret, 'write');
        stub.respond = () =>
          json(201, { number: 7, html_url: `https://github.com/acme/widgets/pull/7?t=${echo}` });

        const res = await call(w, FORGE_OPEN, FORGE_OPEN_ARGS);

        expect(servedText(res)).toBe(
          JSON.stringify({
            url: 'https://github.com/acme/widgets/pull/7?t=[redacted]',
            number: '7',
          }),
        );
        expect(await leakSites(secret)).toEqual([]);
      },
    );
  });

  describe('the method of a vendor request follows the access of its operation', () => {
    it('refuses a DELETE from a read operation: 502 vendor-method-refused, one error row, no request', async () => {
      await mountWith(GET, (made) =>
        made.vendor.request({ method: 'DELETE', url: `${fx.FX_BASE}/v1/docs/d1` }),
      );
      const w = await seed();

      const res = await call(w, GET, { docId: 'd1' });

      expectError(res, 502, 'vendor-method-refused');
      await expectOneRow(w, {
        tool: GET,
        access: 'read',
        outcome: 'error',
        reason: 'vendor-method-refused',
      });
      expect(stub.calls).toEqual([]);
    });

    it('sends a DELETE from a write operation', async () => {
      await mountWith(APPEND, (made) =>
        made.vendor.request({ method: 'DELETE', url: `${fx.FX_BASE}/v1/docs/d1` }),
      );
      const w = await seed({ access: 'write', writeSwitch: true });

      const res = await call(w, APPEND, { docId: 'd1', text: 'x' });

      expect(res.status, textOf(res)).toBe(200);
      expect(stub.calls.map((made) => made.method)).toEqual(['DELETE']);
      await expectOneRow(w, { tool: APPEND, access: 'write', outcome: 'ok', reason: null });
    });
  });
});
