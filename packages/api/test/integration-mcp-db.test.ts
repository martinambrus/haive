import { createHash, createHmac, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.INTEGRATION_MCP_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integration_mcp_test'))
  throw new Error(
    'Use a dedicated integration_mcp_test database for the integration MCP route tests',
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
import { getConnectionCredential } from '@haive/shared/integrations';
import { signTaskToken, type TaskTokenClaims } from '@haive/shared/task-token';
import { createApiApp } from '../src/index.js';
import { INTEGRATION_CALL_BODY_LIMIT_BYTES } from '../src/lib/integration-call-limits.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const KEK = generateEncryptionKey();
const SECRET = `stub${randomUUID()}`;
const USER_PREFIX = 'integration-mcp-test-';
const BUDGET = 50;
const LIMIT = INTEGRATION_CALL_BODY_LIMIT_BYTES;
const MIB = 1024 * 1024;
const LIST = '/integration-mcp/tools/list';
const CALL = '/integration-mcp/call';
const GET = 'get_pull_request_state';
const OPEN = 'open_pull_request';
const API = 'https://api.github.com';
const GITHUB_REMOTE = 'https://github.com/acme/widgets.git';
const OPEN_ARGS = { head: 'feature/x', base: 'main', title: 'Add x', body: 'Adds x.' };

type Row = Record<string, unknown>;
type Access = 'read' | 'write';
type Binding = NonNullable<(typeof schema.cliInvocations.$inferInsert)['integrations']>[number];
type Listed = { name: string; description: string; inputSchema: Record<string, unknown> };

const READ: Row = { tool: GET, access: 'read' };
const WRITE: Row = { tool: OPEN, access: 'write' };

interface World {
  repositoryId: string;
  credentialId: string;
  connectionId: string;
  taskId: string;
  stepId: string;
  invocationId: string;
  secret: string;
}

const PR_OPEN = {
  number: 42,
  state: 'open',
  merged: false,
  merged_at: null,
  html_url: 'https://github.com/acme/widgets/pull/42',
};
const PR_MERGED = { ...PR_OPEN, state: 'closed', merged: true, merged_at: '2026-01-02T03:04:05Z' };
const PR_CLOSED = { ...PR_OPEN, state: 'closed' };
const PR_CREATED = { number: 7, html_url: 'https://github.com/acme/widgets/pull/7' };

interface VendorCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  hasSignal: boolean;
  at: number;
  abortedAt: number | null;
}
type Reply = (call: VendorCall, init: RequestInit) => Response | Promise<Response>;

const vendorJson = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const defaultReply: Reply = (call) =>
  call.method === 'POST' ? vendorJson(201, PR_CREATED) : vendorJson(200, PR_OPEN);

const vendor = {
  calls: [] as VendorCall[],
  respond: defaultReply,
  pending: [] as Array<() => void>,
};

async function vendorFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const asked = input instanceof Request ? input : null;
  const headers = new Headers(asked?.headers);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const call: VendorCall = {
    url: asked?.url ?? String(input),
    method: (init.method ?? asked?.method ?? 'GET').toUpperCase(),
    headers: Object.fromEntries(headers.entries()),
    body: typeof init.body === 'string' ? init.body : null,
    hasSignal: init.signal instanceof AbortSignal,
    at: Date.now(),
    abortedAt: null,
  };
  vendor.calls.push(call);
  init.signal?.addEventListener(
    'abort',
    () => {
      call.abortedAt = Date.now();
    },
    { once: true },
  );
  return vendor.respond(call, init);
}

function hang(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    vendor.pending.push(() => reject(new Error('the stub released a hanging request')));
    const signal = init.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function stallBody(init: RequestInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"number":42,'));
      vendor.pending.push(() => controller.error(new Error('the stub released a stalled body')));
      const signal = init.signal;
      if (!signal) return;
      if (signal.aborted) controller.error(signal.reason);
      else signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

const padded = (bytes: number): string => JSON.stringify({ ...PR_OPEN, pad: 'x'.repeat(bytes) });
const BIG_REPLIES: Array<[string, () => Response]> = [
  [
    'in one chunk, with no Content-Length',
    () => new Response(padded(9 * MIB), { headers: { 'content-type': 'application/json' } }),
  ],
  [
    'in one chunk, with a Content-Length',
    () => {
      const text = padded(9 * MIB);
      return new Response(text, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
        },
      });
    },
  ],
  [
    'in 64 KiB chunks, with no Content-Length',
    () => {
      const bytes = Buffer.from(padded(9 * MIB));
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) return controller.close();
          controller.enqueue(bytes.subarray(offset, offset + 65_536));
          offset += 65_536;
        },
      });
      return new Response(stream, { headers: { 'content-type': 'application/json' } });
    },
  ],
];

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

describe.skipIf(!url)('the integration broker routes, on Postgres', () => {
  let db: Database;
  let app: ReturnType<typeof createApiApp>;
  let ownerId: string;
  let otherId: string;
  const secrets: string[] = [];
  const bodies: string[] = [];

  async function createUser(): Promise<string> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'integration-mcp-test@test.local',
        emailBlindIndex: `${USER_PREFIX}${randomUUID()}`,
        passwordHash: 'not-real',
      })
      .returning({ id: schema.users.id });
    return user!.id;
  }

  async function createCredential(
    userId: string,
    over: {
      host?: string;
      provider?: string | null;
      apiBaseUrl?: string | null;
      secret?: string;
    } = {},
  ): Promise<{ id: string; secret: string }> {
    const secret = over.secret ?? `stub${randomUUID()}`;
    secrets.push(secret);
    const dek = generateDek();
    const [credential] = await db
      .insert(schema.repoCredentials)
      .values({
        userId,
        label: `credential ${randomUUID()}`,
        host: over.host ?? 'github.com',
        provider: over.provider === undefined ? 'github' : over.provider,
        apiBaseUrl: over.apiBaseUrl ?? null,
        usernameEncrypted: encrypt('octocat', dek),
        secretEncrypted: encrypt(secret, dek),
        encryptedDek: encryptDek(dek, KEK),
      })
      .returning({ id: schema.repoCredentials.id });
    return { id: credential!.id, secret };
  }

  async function createConnection(
    userId: string,
    credentialId: string,
    over: Partial<typeof schema.integrationConnections.$inferInsert> = {},
  ): Promise<string> {
    const [connection] = await db
      .insert(schema.integrationConnections)
      .values({
        providerId: 'github',
        scope: 'user',
        ownerUserId: userId,
        accountLabel: 'octocat',
        authMethod: 'token',
        repoCredentialId: credentialId,
        ...over,
      })
      .returning({ id: schema.integrationConnections.id });
    return connection!.id;
  }

  async function createRepository(userId: string, remoteUrl: string | null): Promise<string> {
    const [repository] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: `repo ${randomUUID()}`,
        source: remoteUrl === null ? 'local_path' : 'git_https',
        remoteUrl,
      })
      .returning({ id: schema.repositories.id });
    return repository!.id;
  }

  async function createTask(userId: string, repositoryId: string | null): Promise<string> {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'workflow',
        title: 'integration mcp',
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

  const binding = (connectionId: string, access: Access, over: Partial<Binding> = {}): Binding => ({
    requirementId: 'forge',
    categoryId: 'forge',
    providerId: 'github',
    connectionId,
    access,
    ...over,
  });

  const setStamp = (w: World, stamp: unknown) =>
    db
      .update(schema.cliInvocations)
      .set({ integrations: stamp as Binding[] | null })
      .where(eq(schema.cliInvocations.id, w.invocationId));

  const setSwitch = (userId: string, writeEnabled: boolean, providerId = 'github') =>
    db
      .insert(schema.integrationUserSettings)
      .values({ userId, providerId, writeEnabled })
      .onConflictDoUpdate({
        target: [schema.integrationUserSettings.userId, schema.integrationUserSettings.providerId],
        set: { writeEnabled },
      });

  async function seed(
    opts: { access?: Access; writeSwitch?: boolean; remoteUrl?: string | null } = {},
  ): Promise<World> {
    const credential = await createCredential(ownerId);
    const connectionId = await createConnection(ownerId, credential.id);
    const repositoryId = await createRepository(
      ownerId,
      opts.remoteUrl === undefined ? GITHUB_REMOTE : opts.remoteUrl,
    );
    const taskId = await createTask(ownerId, repositoryId);
    const stepId = await createStep(taskId);
    if (opts.writeSwitch !== undefined) await setSwitch(ownerId, opts.writeSwitch);
    const invocationId = await createInvocation(taskId, stepId, [
      binding(connectionId, opts.access ?? 'read'),
    ]);
    expect(
      await getConnectionCredential(db, connectionId, { fetchFn: vendorFetch as typeof fetch }),
      'the harness fixtures must decrypt through getConnectionCredential',
    ).toEqual({
      accessToken: credential.secret,
      username: 'octocat',
      provider: 'github',
      apiBaseUrl: null,
      host: 'github.com',
    });
    return {
      repositoryId,
      credentialId: credential.id,
      connectionId,
      taskId,
      stepId,
      invocationId,
      secret: credential.secret,
    };
  }

  // The audience-less two-part format: base64url({taskId, exp}).base64url(hmac).
  const legacyRagToken = (taskId: string): string => {
    const payload = Buffer.from(
      JSON.stringify({ taskId, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
  };

  const mint = (w: World, claims: Partial<TaskTokenClaims> = {}, secret = SECRET): string =>
    signTaskToken(
      {
        aud: 'integrations',
        taskId: w.taskId,
        taskStepId: w.stepId,
        cliInvocationId: w.invocationId,
        ...claims,
      },
      secret,
    );

  async function send(
    path: string,
    body: unknown,
    token: string | null,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.clone().text();
    texts.set(res, text);
    bodies.push(text, [...res.headers].map(([name, value]) => `${name}: ${value}`).join('\n'));
    return res;
  }

  const listAs = (token: string | null) => send(LIST, {}, token);
  const callAs = (token: string | null, tool: unknown, args?: unknown) =>
    send(CALL, { tool, ...(args === undefined ? {} : { arguments: args }) }, token);
  const list = (w: World) => listAs(mint(w));
  const call = (w: World, tool: unknown, args?: unknown) => callAs(mint(w), tool, args);

  const rows = async (): Promise<Row[]> => [
    ...(await db.execute<Row>(sql`select * from integration_calls order by created_at, id`)),
  ];

  const rowOf = (w: World, over: Row): Row => ({
    connection_id: w.connectionId,
    provider_id: 'github',
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
    expect(bodyOf(res)).toEqual({ error: expect.any(String), code });
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
    expect(vendor.calls).toEqual([]);
  }

  async function expectNoTrace(): Promise<void> {
    expect(await rows()).toEqual([]);
    expect(vendor.calls).toEqual([]);
  }

  function served(res: Response): Record<string, unknown> {
    expect(res.status, textOf(res)).toBe(200);
    const body = bodyOf(res) as { ok?: unknown; text?: unknown };
    expect(Object.keys(body).sort()).toEqual(['ok', 'text']);
    expect(body.ok).toBe(true);
    expect(typeof body.text).toBe('string');
    return JSON.parse(body.text as string) as Record<string, unknown>;
  }

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
      for (const release of vendor.pending.splice(0)) release();
      pending.catch(() => undefined);
      throw new Error(`no answer within ${ms} ms`);
    }
    return settled;
  }

  async function spendRows(
    w: World,
    count: number,
    invocationId = w.invocationId,
    stepId = w.stepId,
  ): Promise<void> {
    const outcomes = ['ok', 'refused', 'error'] as const;
    await db.insert(schema.integrationCalls).values(
      Array.from({ length: count }, (_, i) => ({
        connectionId: w.connectionId,
        providerId: 'github',
        taskId: w.taskId,
        taskStepId: stepId,
        cliInvocationId: invocationId,
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
    await clean();
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', SECRET);
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    vi.stubGlobal('fetch', vendorFetch);
    vendor.calls = [];
    vendor.respond = defaultReply;
    vendor.pending = [];
    logs.length = 0;
    bodies.length = 0;
    secrets.length = 0;
    await clean();
    ownerId = await createUser();
    otherId = await createUser();
  });

  afterEach(async () => {
    try {
      const released = vendor.pending.splice(0);
      for (const release of released) release();
      if (released.length > 0) await sleep(100);
      const unsignalled = vendor.calls.filter((made) => !made.hasSignal).map((made) => made.url);
      expect(unsignalled, 'vendor requests sent without init.signal').toEqual([]);
      for (const secret of secrets) {
        expect(await leakSites(secret), 'where the access token leaked').toEqual([]);
      }
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  describe('R the routes', () => {
    it.each([LIST, CALL])(
      'does not answer a GET on %s, which must never start work',
      async (path) => {
        const w = await seed();
        const posted = path === LIST ? await list(w) : await call(w, GET, { prNumber: '42' });
        expect(posted.status, textOf(posted)).toBe(200);
        const before = { rows: (await rows()).length, calls: vendor.calls.length };

        const res = await app.request(path, { headers: { authorization: `Bearer ${mint(w)}` } });

        expect(res.status).toBe(404);
        expect({ rows: (await rows()).length, calls: vendor.calls.length }).toEqual(before);
      },
    );

    describe.each([LIST, CALL])('the body limit on %s', (path) => {
      const exactly = (bytes: number): string => JSON.stringify({ pad: 'x'.repeat(bytes - 10) });
      const framings: Array<[string, (text: string) => Record<string, string>]> = [
        ['streamed', () => ({})],
        [
          'with a Content-Length',
          (text) => ({ 'content-length': String(Buffer.byteLength(text)) }),
        ],
      ];

      it.each(framings)(
        'answers 413 one byte past its limit, %s, with a JSON error that names the limit, and writes nothing',
        async (_framing, headers) => {
          const w = await seed({ access: 'write', writeSwitch: true });
          const text = exactly(LIMIT + 1);

          const res = await send(path, text, mint(w), headers(text));

          expect(Buffer.byteLength(text)).toBe(LIMIT + 1);
          expect(res.status, textOf(res)).toBe(413);
          expect(bodyOf(res)).toEqual({
            error: expect.stringContaining(String(LIMIT)),
            code: null,
          });
          await expectNoTrace();
        },
      );

      it('answers 413 before the token is read', async () => {
        const res = await send(path, exactly(LIMIT + 1), null);

        expect(res.status, textOf(res)).toBe(413);
      });
    });

    describe('the typed results', () => {
      const merged = '2026-01-02T03:04:05.000Z';
      const states: Array<[string, unknown, Row]> = [
        ['an open', PR_OPEN, { state: 'open', mergedAt: null }],
        ['a merged', PR_MERGED, { state: 'merged', mergedAt: merged }],
        ['a closed, unmerged', PR_CLOSED, { state: 'closed', mergedAt: null }],
      ];

      it.each(states)(
        'answers {ok, text} with the JSON of %s PR state, and records one ok row',
        async (_name, payload, expected) => {
          const w = await seed();
          vendor.respond = () => vendorJson(200, payload);

          const typed = served(await call(w, GET, { prNumber: '42' }));

          const mergedAt =
            typed.mergedAt === null ? null : new Date(String(typed.mergedAt)).toISOString();
          expect({ ...typed, mergedAt }).toEqual(expected);
          await expectOneRow(w, { ...READ, outcome: 'ok', reason: null });
          expect(vendor.calls).toHaveLength(1);
          expect(vendor.calls[0]).toMatchObject({
            method: 'GET',
            url: `${API}/repos/acme/widgets/pulls/42`,
            hasSignal: true,
          });
          expect(vendor.calls[0]!.headers.authorization).toBe(`Bearer ${w.secret}`);
        },
      );

      it('answers {ok, text} with the JSON of the opened PR, sends the arguments to the vendor, and records one ok row', async () => {
        const w = await seed({ access: 'write', writeSwitch: true });

        const typed = served(await call(w, OPEN, OPEN_ARGS));

        expect(typed).toEqual({ url: PR_CREATED.html_url, number: '7' });
        await expectOneRow(w, { ...WRITE, outcome: 'ok', reason: null });
        expect(vendor.calls).toHaveLength(1);
        expect(vendor.calls[0]).toMatchObject({
          method: 'POST',
          url: `${API}/repos/acme/widgets/pulls`,
          hasSignal: true,
        });
        expect(vendor.calls[0]!.headers.authorization).toBe(`Bearer ${w.secret}`);
        expect(JSON.parse(vendor.calls[0]!.body!)).toEqual({
          title: OPEN_ARGS.title,
          head: OPEN_ARGS.head,
          base: OPEN_ARGS.base,
          body: OPEN_ARGS.body,
        });
      });
    });
  });

  describe('C1 the token and the invocation', () => {
    const forged = (w: World): string => {
      const [version, , mac] = mint(w).split('.');
      const payload = Buffer.from(
        JSON.stringify({
          aud: 'integrations',
          taskId: w.taskId,
          taskStepId: w.stepId,
          cliInvocationId: randomUUID(),
          exp: 99_999_999_999,
        }),
      ).toString('base64url');
      return `${version}.${payload}.${mac}`;
    };
    const badTokens: Array<[string, (w: World) => string | null]> = [
      ['no Authorization header', () => null],
      ['a forged MAC (another invocation swapped in)', forged],
      ['an expired token', (w) => mint(w, { ttlSeconds: -1 })],
      ['a token signed with another secret', (w) => mint(w, {}, `stub${randomUUID()}`)],
      ['a rag-audience token with the same claims', (w) => mint(w, { aud: 'rag' })],
      ['a ddev-audience token with the same claims', (w) => mint(w, { aud: 'ddev' })],
      ['a custom-mcp-audience token with the same claims', (w) => mint(w, { aud: 'custom-mcp' })],
      ['the legacy two-part rag token', (w) => legacyRagToken(w.taskId)],
      ['an integrations token with no taskStepId', (w) => mint(w, { taskStepId: undefined })],
      [
        'an integrations token with no cliInvocationId',
        (w) => mint(w, { cliInvocationId: undefined }),
      ],
      ['a malformed token', () => 'v1.not.a-token'],
    ];

    describe.each([LIST, CALL])('on %s', (path) => {
      const bodyFor = path === LIST ? {} : { tool: GET, arguments: { prNumber: '42' } };

      it.each(badTokens)(
        'answers 401 for %s, lists nothing, writes no row and calls no vendor',
        async (_name, token) => {
          const w = await seed({ access: 'write', writeSwitch: true });

          const res = await send(path, bodyFor, token(w));

          expect(res.status, textOf(res)).toBe(401);
          expect(bodyOf(res)).toMatchObject({ error: expect.any(String) });
          expect(bodyOf(res)).not.toHaveProperty('tools');
          expect(bodyOf(res)).not.toHaveProperty('ok');
          await expectNoTrace();
        },
      );

      const dead: Array<[string, (w: World) => Promise<string>]> = [
        [
          'an ended invocation',
          async (w) => {
            await db
              .update(schema.cliInvocations)
              .set({ endedAt: new Date() })
              .where(eq(schema.cliInvocations.id, w.invocationId));
            return mint(w);
          },
        ],
        [
          'a superseded invocation',
          async (w) => {
            await db
              .update(schema.cliInvocations)
              .set({ supersededAt: new Date() })
              .where(eq(schema.cliInvocations.id, w.invocationId));
            return mint(w);
          },
        ],
        [
          'a token that names another step of the task',
          async (w) => mint(w, { taskStepId: await createStep(w.taskId, '08-review') }),
        ],
        [
          'a token that names another task',
          async (w) => mint(w, { taskId: await createTask(ownerId, w.repositoryId) }),
        ],
        [
          'an invocation that does not exist',
          async (w) => mint(w, { cliInvocationId: randomUUID() }),
        ],
      ];

      it.each(dead)(
        'answers 401 invocation-not-live for %s, writes no row and calls no vendor',
        async (_name, arrange) => {
          const w = await seed({ access: 'write', writeSwitch: true });
          const token = await arrange(w);

          const res = await send(path, bodyFor, token);

          expectError(res, 401, 'invocation-not-live');
          await expectNoTrace();
        },
      );

      it('stops serving an invocation the moment it ends', async () => {
        const w = await seed();
        expect((await send(path, bodyFor, mint(w))).status).toBe(200);
        await db
          .update(schema.cliInvocations)
          .set({ endedAt: new Date() })
          .where(eq(schema.cliInvocations.id, w.invocationId));
        const writtenBefore = (await rows()).length;
        const calledBefore = vendor.calls.length;

        const res = await send(path, bodyFor, mint(w));

        expectError(res, 401, 'invocation-not-live');
        expect((await rows()).length).toBe(writtenBefore);
        expect(vendor.calls).toHaveLength(calledBefore);
      });
    });
  });

  describe('C2 no session is needed', () => {
    it('serves a valid token with no cookie on tools/list and on call', async () => {
      const w = await seed();

      expect(namesOf(await list(w))).toEqual([GET]);
      await expectNoTrace();
      expect(served(await call(w, GET, { prNumber: '42' }))).toEqual({
        state: 'open',
        mergedAt: null,
      });
      await expectOneRow(w, { ...READ, outcome: 'ok', reason: null });
      expect(vendor.calls).toHaveLength(1);
    });
  });

  describe('C3 a step that declares nothing', () => {
    const stamps: Array<[string, unknown]> = [
      ['NULL', null],
      ['an empty list', []],
      ['an object instead of a list', {}],
      ['one entry whose access is not read or write', [{ access: 'admin' }]],
    ];

    it.each(stamps)(
      'lists nothing and answers every call 403 undeclared-tool for a stamp of %s',
      async (_name, stamp) => {
        const w = await seed({ access: 'write', writeSwitch: true });
        await setStamp(w, stamp);

        const listing = await list(w);
        expect(listing.status, textOf(listing)).toBe(200);
        expect(bodyOf(listing)).toEqual({ tools: [] });
        for (const [tool, args] of [
          [GET, { prNumber: '42' }],
          [OPEN, OPEN_ARGS],
          ['anything_else', {}],
        ] as const) {
          expectError(await call(w, tool, args), 403, 'undeclared-tool');
        }
        await expectNoTrace();
      },
    );

    it.each([
      ['a name the stamp does not declare', 'nope'],
      ['a declared name in another case', 'Get_Pull_Request_State'],
      ['an empty name', ''],
      ['a name that is not a string', 5],
      ['no name', undefined],
    ])('answers 403 undeclared-tool, with no row, for %s', async (_name, tool) => {
      const w = await seed();

      expectError(await call(w, tool, { prNumber: '42' }), 403, 'undeclared-tool');
      await expectNoTrace();
    });

    it('answers 403 undeclared-tool, with no row, for a write operation a read binding never declared', async () => {
      const w = await seed({ access: 'read', writeSwitch: true });

      expectError(await call(w, OPEN, OPEN_ARGS), 403, 'undeclared-tool');
      await expectNoTrace();
    });
  });

  describe('C4 the tool list', () => {
    it.each([[true], [false]])(
      'lists the read operation alone for a read binding when the write switch is %s',
      async (on) => {
        const w = await seed({ access: 'read', writeSwitch: on });

        expect(namesOf(await list(w))).toEqual([GET]);
        await expectNoTrace();
      },
    );

    it('lists the read operation alone for a write binding when the owner has no switch row', async () => {
      const w = await seed({ access: 'write' });

      expect(namesOf(await list(w))).toEqual([GET]);
      await expectNoTrace();
    });

    it('lists the read operation alone for a write binding whose switch is off', async () => {
      const w = await seed({ access: 'write', writeSwitch: false });

      expect(namesOf(await list(w))).toEqual([GET]);
      await expectNoTrace();
    });

    it('does not take another user, or another provider, for the owner switch', async () => {
      const w = await seed({ access: 'write' });
      await setSwitch(otherId, true);
      await setSwitch(ownerId, true, 'gitlab');

      expect(namesOf(await list(w))).toEqual([GET]);
      await expectNoTrace();
    });

    it('lists both operations for a write binding whose switch is on, as {name, description, inputSchema} and nothing else, and writes no row', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });

      const tools = listed(await list(w));

      expect(tools.map((tool) => tool.name).sort()).toEqual([GET, OPEN]);
      for (const tool of tools) {
        expect(Object.keys(tool).sort()).toEqual(['description', 'inputSchema', 'name']);
        expect(tool.description.length).toBeGreaterThan(0);
      }
      await expectNoTrace();
    });

    it('carries the argument limits in the input schemas', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      const tools = listed(await list(w));
      const schemaOf = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema;

      expect(schemaOf(GET)).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: { prNumber: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } },
      });
      expect(schemaOf(GET).required).toEqual(['prNumber']);
      expect(Object.keys(schemaOf(GET).properties as object)).toEqual(['prNumber']);
      expect(schemaOf(OPEN)).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: {
          head: { type: 'string', maxLength: 255 },
          base: { type: 'string', maxLength: 255 },
          title: { type: 'string', maxLength: 256 },
          body: { type: 'string', maxLength: 65_536 },
        },
      });
      expect([...(schemaOf(OPEN).required as string[])].sort()).toEqual([
        'base',
        'body',
        'head',
        'title',
      ]);
      expect(Object.keys(schemaOf(OPEN).properties as object).sort()).toEqual([
        'base',
        'body',
        'head',
        'title',
      ]);
      await expectNoTrace();
    });
  });

  describe('C5 the write switch is read on every call', () => {
    const flips: Array<[string, (userId: string) => PromiseLike<unknown>]> = [
      ['set to off', (userId) => setSwitch(userId, false)],
      [
        'removed',
        (userId) =>
          db
            .delete(schema.integrationUserSettings)
            .where(eq(schema.integrationUserSettings.userId, userId)),
      ],
    ];

    it.each(flips)(
      'answers 403 write-switched-off after the switch is %s, records one refused row, and calls no vendor',
      async (_name, flip) => {
        const w = await seed({ access: 'write', writeSwitch: true });
        expect(namesOf(await list(w))).toEqual([GET, OPEN]);
        await flip(ownerId);

        const res = await call(w, OPEN, OPEN_ARGS);

        await expectRefusal(w, res, 403, 'write-switched-off', WRITE);
      },
    );

    it('serves the same call again once the switch is back on', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      await setSwitch(ownerId, false);
      expect((await call(w, OPEN, OPEN_ARGS)).status).toBe(403);
      await setSwitch(ownerId, true);

      const typed = served(await call(w, OPEN, OPEN_ARGS));

      expect(typed).toEqual({ url: PR_CREATED.html_url, number: '7' });
      expect(vendor.calls).toHaveLength(1);
      expect((await rows()).map((row) => row.outcome)).toEqual(['refused', 'ok']);
    });
  });

  describe('C5 what the list never offered cannot be called', () => {
    async function expectWriteRefused(w: World, res: Response, over: Row = {}): Promise<void> {
      expect(res.status, textOf(res)).toBe(403);
      const code = (bodyOf(res) as { code?: unknown }).code;
      expect(['write-switched-off', 'undeclared-tool'], textOf(res)).toContain(code);
      if (code === 'write-switched-off') {
        await expectOneRow(w, { ...WRITE, ...over, outcome: 'refused', reason: code });
      } else {
        expect(await rows()).toEqual([]);
      }
      expect(vendor.calls).toEqual([]);
    }

    const arrangements: Array<[string, (w: World) => PromiseLike<unknown> | void]> = [
      ['an owner with no switch row', () => undefined],
      ['an owner whose switch is off', () => setSwitch(ownerId, false)],
      ['a switch that belongs to another user', () => setSwitch(otherId, true)],
    ];

    it.each(arrangements)(
      'refuses open_pull_request, which a write binding declares, for %s',
      async (_name, arrange) => {
        const w = await seed({ access: 'write' });
        await arrange(w);
        expect(namesOf(await list(w))).toEqual([GET]);

        await expectWriteRefused(w, await call(w, OPEN, OPEN_ARGS));
      },
    );

    it('keeps one write switch per provider: the write operation of a provider whose switch is off stays out of the list and cannot be called', async () => {
      const w = await seed({ remoteUrl: 'https://git.example.com/acme/widgets.git' });
      const gitea = await createCredential(ownerId, { host: 'git.example.com', provider: 'gitea' });
      const gitlab = await createCredential(ownerId, {
        host: 'git.example.com',
        provider: 'gitlab',
      });
      const giteaConnection = await createConnection(ownerId, gitea.id, { providerId: 'gitea' });
      const gitlabConnection = await createConnection(ownerId, gitlab.id, {
        providerId: 'gitlab',
      });
      await setStamp(w, [
        binding(giteaConnection, 'write', { requirementId: 'source', providerId: 'gitea' }),
        binding(gitlabConnection, 'write', { requirementId: 'mirror', providerId: 'gitlab' }),
      ]);
      await setSwitch(ownerId, true, 'gitea');

      expect(namesOf(await list(w))).toEqual([
        'mirror_get_pull_request_state',
        'source_get_pull_request_state',
        'source_open_pull_request',
      ]);
      await expectWriteRefused(w, await call(w, 'mirror_open_pull_request', OPEN_ARGS), {
        tool: 'mirror_open_pull_request',
        provider_id: 'gitlab',
        connection_id: gitlabConnection,
      });
      served(await call(w, 'source_open_pull_request', OPEN_ARGS));
      expect(vendor.calls.map((made) => made.url)).toEqual([
        'https://git.example.com/api/v1/repos/acme/widgets/pulls',
      ]);
    });
  });

  describe('C6 the call budget', () => {
    it('serves 50 of 100 parallel calls and answers the other 50 429 budget-spent, with 50 rows and 50 vendor calls', async () => {
      const w = await seed();
      const token = mint(w);

      const responses = await Promise.all(
        Array.from({ length: 100 }, () => callAs(token, GET, { prNumber: '42' })),
      );

      const byStatus = (status: number) => responses.filter((res) => res.status === status);
      expect(byStatus(200)).toHaveLength(BUDGET);
      expect(byStatus(429)).toHaveLength(BUDGET);
      for (const res of byStatus(429)) {
        expect(bodyOf(res)).toEqual({ error: expect.any(String), code: 'budget-spent' });
      }
      const found = await rows();
      expect(found).toHaveLength(BUDGET);
      expect(found.every((row) => row.outcome === 'ok')).toBe(true);
      expect(vendor.calls).toHaveLength(BUDGET);
    });

    it('counts rows of every outcome: 49 spent, the 50th call is served and the 51st is 429 with no row and no vendor call', async () => {
      const w = await seed();
      await spendRows(w, BUDGET - 1);

      expect((await call(w, GET, { prNumber: '42' })).status).toBe(200);
      expect(await rows()).toHaveLength(BUDGET);
      const res = await call(w, GET, { prNumber: '42' });

      expectError(res, 429, 'budget-spent');
      expect(await rows()).toHaveLength(BUDGET);
      expect(vendor.calls).toHaveLength(1);
    });

    it('counts per invocation: another invocation of the task is still served', async () => {
      const w = await seed();
      await spendRows(w, BUDGET);
      const stepId = await createStep(w.taskId, '08-review');
      const invocationId = await createInvocation(w.taskId, stepId, [
        binding(w.connectionId, 'read'),
      ]);
      expectError(await call(w, GET, { prNumber: '42' }), 429, 'budget-spent');

      const res = await callAs(
        mint(w, { taskStepId: stepId, cliInvocationId: invocationId }),
        GET,
        { prNumber: '42' },
      );

      expect(res.status, textOf(res)).toBe(200);
      expect(vendor.calls).toHaveLength(1);
    });
  });

  describe('C7 the arguments', () => {
    const badNumbers: Array<[string, unknown]> = [
      ['a number made of dots', { prNumber: '..' }],
      ['a number that climbs out of the path', { prNumber: '../../user' }],
      ['a number with a slash', { prNumber: '1/2' }],
      ['an empty number', { prNumber: '' }],
      ['a word', { prNumber: 'x' }],
      ['a JSON number', { prNumber: 42 }],
      ['an extra key', { prNumber: '42', extra: 1 }],
      ['zero', { prNumber: '0' }],
      ['a leading zero', { prNumber: '01' }],
      ['eleven digits', { prNumber: '12345678901' }],
      ['no number', {}],
      ['arguments that are a string', 'prNumber'],
      ['arguments that are a list', ['42']],
    ];

    it.each(badNumbers)(
      'answers 400 invalid-arguments for %s, with one refused row and no vendor call',
      async (_name, args) => {
        const w = await seed();

        await expectRefusal(w, await call(w, GET, args), 400, 'invalid-arguments');
      },
    );

    it('answers 400 invalid-arguments when the arguments are left out', async () => {
      const w = await seed();

      await expectRefusal(w, await call(w, GET), 400, 'invalid-arguments');
    });

    it('serves a ten-digit number', async () => {
      const w = await seed();

      served(await call(w, GET, { prNumber: '9999999999' }));

      expect(vendor.calls[0]!.url).toBe(`${API}/repos/acme/widgets/pulls/9999999999`);
    });

    const without = (key: keyof typeof OPEN_ARGS): Row => {
      const copy: Row = { ...OPEN_ARGS };
      delete copy[key];
      return copy;
    };
    const badOpens: Array<[string, unknown]> = [
      ['a head that starts with a dash', { ...OPEN_ARGS, head: '-rf' }],
      ['a head with two dots', { ...OPEN_ARGS, head: 'a..b' }],
      ['a base that starts with a dash', { ...OPEN_ARGS, base: '-rf' }],
      ['a head of 256 characters', { ...OPEN_ARGS, head: 'h'.repeat(256) }],
      ['a base of 256 characters', { ...OPEN_ARGS, base: 'b'.repeat(256) }],
      ['a title of 257 characters', { ...OPEN_ARGS, title: 't'.repeat(257) }],
      ['an empty title', { ...OPEN_ARGS, title: '' }],
      ['a title that is not a string', { ...OPEN_ARGS, title: 5 }],
      ['an extra key', { ...OPEN_ARGS, draft: true }],
      ['no body', without('body')],
      ['no head', without('head')],
    ];

    it.each(badOpens)(
      'answers 400 invalid-arguments for %s, with one refused row and no vendor call',
      async (_name, args) => {
        const w = await seed({ access: 'write', writeSwitch: true });

        await expectRefusal(w, await call(w, OPEN, args), 400, 'invalid-arguments', WRITE);
      },
    );

    it('refuses a body of 65537 characters as invalid-arguments and calls no vendor', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });

      const res = await call(w, OPEN, { ...OPEN_ARGS, body: 'x'.repeat(65_537) });

      await expectRefusal(w, res, 400, 'invalid-arguments', WRITE);
    });

    it('carries a body of 65536 characters outside the BMP sent as escaped surrogate pairs to the vendor', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      const text = `{"tool":"${OPEN}","arguments":{"head":"feature/x","base":"main","title":"Add x","body":"${'\\uD83D\\uDE00'.repeat(65_536)}"}}`;

      const res = await send(CALL, text, mint(w));

      expect(Buffer.byteLength(text)).toBeGreaterThan(12 * 65_536);
      served(res);
      expect(JSON.parse(vendor.calls[0]!.body!).body).toBe(
        String.fromCodePoint(0x1f600).repeat(65_536),
      );
    });

    it('carries a body of 65536 characters to the vendor when every character arrives JSON-escaped', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      const text = `{"tool":"${OPEN}","arguments":{"head":"feature/x","base":"main","title":"Add x","body":"${'\\u0078'.repeat(65_536)}"}}`;

      const res = await send(CALL, text, mint(w));

      expect(Buffer.byteLength(text)).toBeGreaterThan(6 * 65_536);
      served(res);
      expect(JSON.parse(vendor.calls[0]!.body!).body).toBe('x'.repeat(65_536));
    });

    it('sends a title of exactly 256 characters to the vendor', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      const title = 't'.repeat(256);

      served(await call(w, OPEN, { ...OPEN_ARGS, title }));

      expect(vendor.calls).toHaveLength(1);
      expect(JSON.parse(vendor.calls[0]!.body!).title).toBe(title);
    });

    it('sends a head and a base of exactly 255 characters, and a body of 60000, to the vendor', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      const args = {
        ...OPEN_ARGS,
        head: 'h'.repeat(255),
        base: 'b'.repeat(255),
        body: 'x'.repeat(60_000),
      };

      served(await call(w, OPEN, args));

      expect(vendor.calls).toHaveLength(1);
      expect(JSON.parse(vendor.calls[0]!.body!)).toMatchObject({
        head: args.head,
        base: args.base,
        body: args.body,
      });
    });
  });

  describe('C8 vendor failures', () => {
    const statuses: Array<[number, string]> = [
      [401, 'vendor-auth'],
      [404, 'vendor-not-found'],
      [429, 'vendor-rate-limited'],
      [500, 'vendor-error'],
    ];

    it.each(statuses)(
      'answers 502 for a vendor %s as %s, with one error row',
      async (status, code) => {
        const w = await seed();
        vendor.respond = () => vendorJson(status, { message: 'the vendor says no' });

        const res = await call(w, GET, { prNumber: '42' });

        expectError(res, 502, code);
        await expectOneRow(w, { ...READ, outcome: 'error', reason: code });
        expect(vendor.calls).toHaveLength(1);
      },
    );

    it('answers 502 vendor-error when the connection to the vendor fails', async () => {
      const w = await seed();
      vendor.respond = () => Promise.reject(new TypeError('fetch failed'));

      const res = await call(w, GET, { prNumber: '42' });

      expectError(res, 502, 'vendor-error');
      await expectOneRow(w, { ...READ, outcome: 'error', reason: 'vendor-error' });
    });

    it('answers 502 vendor-conflict when the vendor refuses the create and no PR is open for the branch pair', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      vendor.respond = (made) =>
        made.method === 'POST'
          ? vendorJson(422, { message: 'Validation Failed' })
          : vendorJson(200, []);

      const res = await call(w, OPEN, OPEN_ARGS);

      expectError(res, 502, 'vendor-conflict');
      await expectOneRow(w, { ...WRITE, outcome: 'error', reason: 'vendor-conflict' });
      expect(vendor.calls.map((made) => made.method)).toEqual(['POST', 'GET']);
    });

    it('answers the existing PR when the vendor refuses the create and one is open for the branch pair', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      const existing = { number: 9, html_url: 'https://github.com/acme/widgets/pull/9' };
      vendor.respond = (made) =>
        made.method === 'POST'
          ? vendorJson(422, { message: 'A pull request already exists' })
          : vendorJson(200, [existing]);

      const typed = served(await call(w, OPEN, OPEN_ARGS));

      expect(typed).toEqual({ url: existing.html_url, number: '9' });
      await expectOneRow(w, { ...WRITE, outcome: 'ok', reason: null });
      expect(vendor.calls.map((made) => made.method)).toEqual(['POST', 'GET']);
    });

    const hangs: Array<[string, (init: RequestInit) => Promise<Response> | Response]> = [
      ['never answers', hang],
      ['sends its headers and stalls the body', stallBody],
    ];

    it.each(hangs)(
      'answers 504 timeout within the deadline + 2 s when the vendor %s, with one error row',
      async (_name, respond) => {
        const w = await seed();
        vendor.respond = (_made, init) => respond(init);
        const started = Date.now();

        const res = await answeredWithin(h.deadlineMs + 2000, call(w, GET, { prNumber: '42' }));

        expect(Date.now() - started).toBeLessThan(h.deadlineMs + 2000);
        expectError(res, 504, 'timeout');
        await expectOneRow(w, { ...READ, outcome: 'error', reason: 'timeout' });
        expect(vendor.calls).toHaveLength(1);
        expect(vendor.calls[0]!.abortedAt, 'the deadline must abort init.signal').not.toBeNull();
      },
    );

    it(
      'spends one total deadline on the whole call: a create answered 422 late and a follow-up lookup that hangs time out together',
      { retry: 2 },
      async () => {
        const w = await seed({ access: 'write', writeSwitch: true });
        vendor.respond = (made, init) =>
          made.method === 'POST'
            ? sleep(250).then(() => vendorJson(422, { message: 'Validation Failed' }))
            : hang(init);

        const res = await answeredWithin(h.deadlineMs + 2000, call(w, OPEN, OPEN_ARGS));

        expectError(res, 504, 'timeout');
        await expectOneRow(w, { ...WRITE, outcome: 'error', reason: 'timeout' });
        expect(vendor.calls.map((made) => made.method)).toEqual(['POST', 'GET']);
        const [create, lookup] = vendor.calls;
        expect(
          lookup!.abortedAt,
          'the deadline must abort the lookup through init.signal',
        ).not.toBeNull();
        expect(lookup!.abortedAt! - create!.at).toBeLessThan(h.deadlineMs + 125);
      },
    );

    it.each(BIG_REPLIES)(
      'answers 502 vendor-error, not a 200, for a 9 MiB vendor body %s',
      async (_name, big) => {
        const w = await seed();
        vendor.respond = () => big();

        const res = await answeredWithin(h.deadlineMs + 2000, call(w, GET, { prNumber: '42' }));

        expectError(res, 502, 'vendor-error');
        await expectOneRow(w, { ...READ, outcome: 'error', reason: 'vendor-error' });
        expect(vendor.calls).toHaveLength(1);
      },
    );
  });

  describe('C9 the connection', () => {
    const askForState = (w: World) => call(w, GET, { prNumber: '42' });

    it.each(['needs_reauth', 'revoked'] as const)(
      'answers 403 connection-unavailable for a connection whose status is %s',
      async (status) => {
        const w = await seed();
        await db
          .update(schema.integrationConnections)
          .set({ status })
          .where(eq(schema.integrationConnections.id, w.connectionId));

        await expectRefusal(w, await askForState(w), 403, 'connection-unavailable');
      },
    );

    it('answers 403 connection-unavailable for a user connection owned by another user', async () => {
      const w = await seed();
      const theirs = await createCredential(otherId);
      const theirConnection = await createConnection(otherId, theirs.id);
      await setStamp(w, [binding(theirConnection, 'read')]);

      await expectRefusal(w, await askForState(w), 403, 'connection-unavailable', {
        ...READ,
        connection_id: theirConnection,
      });
    });

    it.each([
      ["the task owner's", () => ownerId],
      ["another user's", () => otherId],
    ])(
      'answers 403 connection-unavailable for a shared connection that is %s, with every write switch on',
      async (_name, ownerOf) => {
        const w = await seed({ access: 'write', writeSwitch: true });
        const credential = await createCredential(ownerOf());
        const shared = await createConnection(ownerOf(), credential.id, {
          scope: 'shared',
          writeEnabled: true,
        });
        await setStamp(w, [binding(shared, 'write')]);

        for (const [tool, args, op] of [
          [GET, { prNumber: '42' }, READ],
          [OPEN, OPEN_ARGS, WRITE],
        ] as const) {
          await db.delete(schema.integrationCalls);
          await expectRefusal(w, await call(w, tool, args), 403, 'connection-unavailable', {
            ...op,
            connection_id: shared,
          });
        }
      },
    );

    it.each([
      ['its provider pinned to another forge', { provider: 'gitea' }],
      ['its host moved to another public forge', { provider: null, host: 'gitlab.com' }],
    ])(
      'answers 403 connection-unavailable, never a 500, once the credential has %s',
      async (_name, edit) => {
        const w = await seed();
        await db
          .update(schema.repoCredentials)
          .set(edit)
          .where(eq(schema.repoCredentials.id, w.credentialId));

        await expectRefusal(w, await askForState(w), 403, 'connection-unavailable');
      },
    );

    it('answers 403 connection-unavailable, with a row that names no connection, once the connection is gone', async () => {
      const w = await seed();
      await db
        .delete(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, w.connectionId));

      await expectRefusal(w, await askForState(w), 403, 'connection-unavailable', {
        ...READ,
        connection_id: null,
      });
    });

    it('answers 403 provider-unavailable once the admin has switched the provider off', async () => {
      const w = await seed();
      await db
        .insert(schema.integrationProviderConfigs)
        .values({ providerId: 'github', enabled: false });

      await expectRefusal(w, await askForState(w), 403, 'provider-unavailable');
    });

    it('answers 403 connection-not-for-repository for a gitlab connection on a github.com repository', async () => {
      const w = await seed();
      const gitlab = await createCredential(ownerId, { host: 'gitlab.com', provider: 'gitlab' });
      const gitlabConnection = await createConnection(ownerId, gitlab.id, {
        providerId: 'gitlab',
      });
      await setStamp(w, [binding(gitlabConnection, 'read', { providerId: 'gitlab' })]);

      await expectRefusal(w, await askForState(w), 403, 'connection-not-for-repository', {
        ...READ,
        connection_id: gitlabConnection,
        provider_id: 'gitlab',
      });
    });

    it.each([[null], ['']])(
      'answers 409 no-remote for a repository whose remote_url is %j',
      async (remoteUrl) => {
        const w = await seed({ remoteUrl });

        await expectRefusal(w, await askForState(w), 409, 'no-remote');
      },
    );
  });

  describe('C10 the API base', () => {
    it.each([
      ['http://api.github.com'],
      ['https://evil.example'],
      ['https://u@api.github.com'],
      ['https://api.github.com?x=1'],
      ['https://api.github.com#f'],
      ['https://api.github.com.evil.example'],
    ])(
      'answers 403 unsafe-api-base for a credential whose API base is %s, and calls no vendor',
      async (apiBaseUrl) => {
        const w = await seed();
        await db
          .update(schema.repoCredentials)
          .set({ apiBaseUrl })
          .where(eq(schema.repoCredentials.id, w.credentialId));

        await expectRefusal(w, await call(w, GET, { prNumber: '42' }), 403, 'unsafe-api-base');
      },
    );

    it.each([
      ['https://github.com/acme/widgets.git'],
      ['https://github.com/acme/widgets'],
      ['git@github.com:acme/widgets.git'],
    ])(
      'sends a credential with no API base to api.github.com, with the owner and repo of the remote %s',
      async (remoteUrl) => {
        const w = await seed({ remoteUrl });

        served(await call(w, GET, { prNumber: '42' }));

        expect(vendor.calls).toHaveLength(1);
        expect(vendor.calls[0]).toMatchObject({
          method: 'GET',
          url: `${API}/repos/acme/widgets/pulls/42`,
        });
        expect(vendor.calls[0]!.headers.authorization).toBe(`Bearer ${w.secret}`);
        await expectOneRow(w, { ...READ, outcome: 'ok', reason: null });
      },
    );

    it("sends a credential with no API base on a self-hosted GitHub to that host's own API", async () => {
      const w = await seed({ remoteUrl: 'https://ghe.example.com/acme/widgets.git' });
      await db
        .update(schema.repoCredentials)
        .set({ host: 'ghe.example.com' })
        .where(eq(schema.repoCredentials.id, w.credentialId));

      served(await call(w, GET, { prNumber: '42' }));

      expect(vendor.calls.map((made) => made.url)).toEqual([
        'https://ghe.example.com/api/v3/repos/acme/widgets/pulls/42',
      ]);
    });
  });

  describe('C11 a stamp whose tools cannot be named', () => {
    const stamps: Array<[string, string, string]> = [
      ['two bindings with one requirement id', 'forge', 'forge'],
      ['a prefixed tool name that starts with a digit', '2nd-source', 'mirror'],
    ];

    it.each(stamps)(
      'answers 409 tools-unlistable on both routes for %s, and writes no row',
      async (_name, first, second) => {
        const w = await seed();
        const extra = await createCredential(ownerId);
        const extraConnection = await createConnection(ownerId, extra.id);
        await setStamp(w, [
          binding(w.connectionId, 'read', { requirementId: first }),
          binding(extraConnection, 'read', { requirementId: second }),
        ]);

        expectError(await list(w), 409, 'tools-unlistable');
        expectError(await call(w, GET, { prNumber: '42' }), 409, 'tools-unlistable');
        await expectNoTrace();
      },
    );

    it('lists two bindings with distinct requirement ids under prefixed names, and sends each call to its own connection', async () => {
      const w = await seed();
      const second = await createCredential(ownerId);
      const secondConnection = await createConnection(ownerId, second.id);
      await setStamp(w, [
        binding(w.connectionId, 'read', { requirementId: 'source' }),
        binding(secondConnection, 'read', { requirementId: 'mirror' }),
      ]);

      expect(namesOf(await list(w))).toEqual([
        'mirror_get_pull_request_state',
        'source_get_pull_request_state',
      ]);
      served(await call(w, 'mirror_get_pull_request_state', { prNumber: '42' }));
      served(await call(w, 'source_get_pull_request_state', { prNumber: '42' }));

      expect(vendor.calls.map((made) => made.headers.authorization)).toEqual([
        `Bearer ${second.secret}`,
        `Bearer ${w.secret}`,
      ]);
      expect((await rows()).map((row) => [row.tool, row.connection_id])).toEqual([
        ['mirror_get_pull_request_state', secondConnection],
        ['source_get_pull_request_state', w.connectionId],
      ]);
    });

    it('lists a prefixed name of 41 characters cut to 40 with a digest, and sends a call by it to its own connection', async () => {
      const w = await seed();
      const second = await createCredential(ownerId);
      const secondConnection = await createConnection(ownerId, second.id);
      const digest = createHash('sha256')
        .update('source-repository2\nget_pull_request_state')
        .digest('hex')
        .slice(0, 8);
      const cut = `source_repository2_get_pull_req_${digest}`;
      await setStamp(w, [
        binding(w.connectionId, 'read', { requirementId: 'source-repository2' }),
        binding(secondConnection, 'read', { requirementId: 'mirror' }),
      ]);

      expect(namesOf(await list(w))).toEqual(['mirror_get_pull_request_state', cut]);
      served(await call(w, cut, { prNumber: '42' }));

      expect(vendor.calls.map((made) => made.headers.authorization)).toEqual([
        `Bearer ${w.secret}`,
      ]);
      expect((await rows()).map((row) => [row.tool, row.connection_id])).toEqual([
        [cut, w.connectionId],
      ]);
    });
  });

  describe('C12 the stamp is the authority', () => {
    it('lists and serves what the stamp names, whatever the grants and choices of the task say, or stop saying', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      const other = await createCredential(ownerId);
      const otherConnection = await createConnection(ownerId, other.id);
      await db.insert(schema.integrationGrants).values({
        connectionId: w.connectionId,
        targetKind: 'task',
        taskId: w.taskId,
        categoryId: 'forge',
      });
      await db.insert(schema.taskIntegrationChoices).values({
        taskId: w.taskId,
        categoryId: 'forge',
        providerId: 'github',
        connectionId: otherConnection,
      });
      expect(namesOf(await list(w))).toEqual([GET, OPEN]);
      expect(served(await call(w, GET, { prNumber: '42' }))).toEqual({
        state: 'open',
        mergedAt: null,
      });

      await db
        .delete(schema.integrationGrants)
        .where(eq(schema.integrationGrants.taskId, w.taskId));
      await db
        .delete(schema.taskIntegrationChoices)
        .where(eq(schema.taskIntegrationChoices.taskId, w.taskId));

      expect(namesOf(await list(w))).toEqual([GET, OPEN]);
      expect(served(await call(w, OPEN, OPEN_ARGS))).toEqual({
        url: PR_CREATED.html_url,
        number: '7',
      });
      expect(vendor.calls.map((made) => made.headers.authorization)).toEqual([
        `Bearer ${w.secret}`,
        `Bearer ${w.secret}`,
      ]);
      expect((await rows()).map((row) => [row.tool, row.outcome, row.connection_id])).toEqual([
        [GET, 'ok', w.connectionId],
        [OPEN, 'ok', w.connectionId],
      ]);
    });
  });

  describe('C13 the access token', () => {
    it('reaches the vendor in Authorization and nothing else: no response, no row, no log line holds it', async () => {
      const w = await seed({ access: 'write', writeSwitch: true });
      const reflect =
        (status: number): Reply =>
        (made) =>
          vendorJson(status, { message: 'Bad credentials', received: made.headers.authorization });

      served(await call(w, GET, { prNumber: '42' }));
      await list(w);
      expect((await call(w, GET, { prNumber: 'x' })).status).toBe(400);
      vendor.respond = reflect(401);
      expect((await call(w, GET, { prNumber: '42' })).status).toBe(502);
      vendor.respond = reflect(500);
      expect((await call(w, GET, { prNumber: '42' })).status).toBe(502);
      vendor.respond = (made) =>
        made.method === 'POST' ? reflect(422)(made, {}) : reflect(500)(made, {});
      expect((await call(w, OPEN, OPEN_ARGS)).status).toBe(502);
      vendor.respond = defaultReply;
      served(await call(w, OPEN, OPEN_ARGS));

      expect(vendor.calls.length).toBeGreaterThanOrEqual(5);
      for (const made of vendor.calls) {
        expect(made.headers.authorization).toBe(`Bearer ${w.secret}`);
      }
      expect(
        logs.some((line) => line.includes(`"path":"${CALL}"`)),
        'the log capture must see the request log',
      ).toBe(true);
      expect(await leakSites(w.secret)).toEqual([]);
    });

    it('keeps every part of a long token out of an echo the error cut would split', async () => {
      const long = `stub${randomUUID()}${'q'.repeat(560)}`;
      const credential = await createCredential(ownerId, { secret: long });
      const connectionId = await createConnection(ownerId, credential.id);
      const repositoryId = await createRepository(ownerId, GITHUB_REMOTE);
      const taskId = await createTask(ownerId, repositoryId);
      const stepId = await createStep(taskId);
      const invocationId = await createInvocation(taskId, stepId, [binding(connectionId, 'read')]);
      const w: World = {
        repositoryId,
        credentialId: credential.id,
        connectionId,
        taskId,
        stepId,
        invocationId,
        secret: long,
      };
      vendor.respond = (made) =>
        vendorJson(401, { pad: 'p'.repeat(60), received: made.headers.authorization });

      expectError(await call(w, GET, { prNumber: '42' }), 502, 'vendor-auth');

      const windows = Array.from({ length: long.length - 11 }, (_, i) => long.slice(i, i + 12));
      const seen = [...bodies, JSON.stringify(await rows()), ...logs];
      expect(windows.filter((window) => seen.some((text) => text.includes(window)))).toEqual([]);
    });

    it('keeps the Basic form a Bitbucket Cloud token travels in out of everything the vendor echoes', async () => {
      const credential = await createCredential(ownerId, {
        host: 'bitbucket.org',
        provider: 'bitbucket_cloud',
      });
      const basic = Buffer.from(`octocat:${credential.secret}`).toString('base64');
      secrets.push(basic);
      const connectionId = await createConnection(ownerId, credential.id, {
        providerId: 'bitbucket_cloud',
      });
      const repositoryId = await createRepository(
        ownerId,
        'https://bitbucket.org/acme/widgets.git',
      );
      const taskId = await createTask(ownerId, repositoryId);
      const stepId = await createStep(taskId);
      const invocationId = await createInvocation(taskId, stepId, [
        binding(connectionId, 'read', { providerId: 'bitbucket_cloud' }),
      ]);
      const w: World = {
        repositoryId,
        credentialId: credential.id,
        connectionId,
        taskId,
        stepId,
        invocationId,
        secret: credential.secret,
      };
      vendor.respond = (made) =>
        vendorJson(401, { message: 'Bad credentials', received: made.headers.authorization });

      expectError(await call(w, GET, { prNumber: '42' }), 502, 'vendor-auth');

      expect(vendor.calls.map((made) => made.headers.authorization)).toEqual([`Basic ${basic}`]);
      expect(await leakSites(basic)).toEqual([]);
    });
  });
});
