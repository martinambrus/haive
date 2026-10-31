import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import {
  encrypt,
  encryptDek,
  envelopeDecrypt,
  envelopeEncrypt,
  generateDek,
  secretsService,
  userSecretsService,
} from '@haive/shared';
import { VENDOR_CALL_TIMEOUT_MS, decryptConnectionTokens } from '@haive/shared/integrations';
import type { IntegrationProviderSpec } from '@haive/shared/modularity';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { initDatabase } from '../src/db.js';
import { closeRedis, getRedis, initRedis } from '../src/redis.js';

const url = process.env.INTEGRATIONS_BROKER_TEST_URL;
const redisUrl = process.env.INTEGRATIONS_BROKER_TEST_REDIS_URL;
if (url && !new URL(url).pathname.startsWith('/integrations_broker_test'))
  throw new Error('Use a dedicated integrations_broker_test database for the broker route tests');

const h = vi.hoisted(() => {
  const userInfo = {
    url: 'https://stub.example.test/api/me',
    idPointer: '/id',
    labelPointer: '/email',
  };
  const stub = {
    id: 'module.stub.vendor',
    displayName: 'Stub Vendor',
    categories: ['file-storage'],
    selfHosted: false,
    auth: [
      {
        kind: 'oauth2',
        authorizeUrl: 'https://stub.example.test/oauth/authorize',
        tokenUrl: 'https://stub.example.test/oauth/token',
        revokeUrl: 'https://stub.example.test/oauth/revoke',
        scopes: { read: ['files.read'], write: ['files.write'] },
        pkce: true,
        clientRegistration: ['preregistered'],
        authorizeParams: { access_type: 'offline', prompt: 'consent' },
        userInfo,
      },
      {
        kind: 'device',
        deviceCodeUrl: 'https://stub.example.test/device/code',
        tokenUrl: 'https://stub.example.test/oauth/token',
        scopes: { read: ['files.read'], write: ['files.write'] },
        userInfo,
      },
    ],
    operations: [
      { opId: 'read_file', description: 'Read a file', inputSchema: {}, access: 'read' },
      { opId: 'write_file', description: 'Write a file', inputSchema: {}, access: 'write' },
    ],
  } satisfies IntegrationProviderSpec;
  return { stub };
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
}));
vi.mock('@haive/shared/integrations', async (importOriginal) => {
  const original = await importOriginal<typeof import('@haive/shared/integrations')>();
  const providers = () => [...original.listIntegrationProviders(), h.stub];
  return {
    ...original,
    listIntegrationProviders: providers,
    getIntegrationProvider: (id: string) => providers().find((p) => p.id === id),
    loadProviderEnablement: async (db: Parameters<typeof original.loadProviderEnablement>[0]) =>
      new Map([
        ...(await original.loadProviderEnablement(db)),
        [h.stub.id, await original.isProviderEnabled(db, h.stub.id)],
      ]),
  };
});

const APP_ORIGIN = 'http://localhost:3000';
const KEK = 'ab'.repeat(32);
const JWT_SECRET = 'integrations-broker-test-jwt-secret';
const STUB_ID = h.stub.id;
const STUB = {
  authorize: 'https://stub.example.test/oauth/authorize',
  token: 'https://stub.example.test/oauth/token',
  revoke: 'https://stub.example.test/oauth/revoke',
  device: 'https://stub.example.test/device/code',
  me: 'https://stub.example.test/api/me',
};
const GITHUB = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  device: 'https://github.com/login/device/code',
  me: 'https://api.github.com/user',
  repos: 'https://api.github.com/user/repos',
};
const ADMIN_CLIENT = { id: 'stub-admin-client-id', secret: 'stub-admin-client-secret' };
const SECOND_CLIENT_ID = 'stub-admin-client-id-2';
const GITHUB_CLIENT = { id: 'gh-env-client-id', secret: 'stub-env-client-secret' };
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CORE_FORGES = ['github', 'gitea', 'gitlab', 'bitbucket_cloud', 'bitbucket_server'];
const INVALID_STATE = /invalid, expired or already used/;
const EXPIRING = /issues expiring tokens; use an OAuth App/;

// Fake credentials the vendor stubs hand out: none may reach a response body or an audit row.
const SECRET_MARKERS = [
  'tok-stub-access',
  'tok-stub-refresh',
  'tok-gh-access',
  'tok-gh-refresh',
  'stub-auth-code',
  'stub-device-code',
  ADMIN_CLIENT.secret,
  GITHUB_CLIENT.secret,
];

type Body = Record<string, any>;
type Account = { id: string | number; label: string };
type DeviceAnswer =
  'pending' | 'slow_down' | 'approve' | 'access_denied' | 'expired_token' | 'unavailable' | 'hang';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonOrEmpty = (text: string): Body => {
  try {
    return JSON.parse(text) as Body;
  } catch {
    return {};
  }
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const hang: Handler = (_call, signal) =>
  new Promise<Response>((_resolve, reject) =>
    signal?.addEventListener('abort', () => reject(signal.reason)),
  );

interface VendorCall {
  method: string;
  url: string;
  form: Record<string, string>;
  headers: Record<string, string>;
}
type Handler = (call: VendorCall, signal: AbortSignal | undefined) => Response | Promise<Response>;

/** The injected fetch: routes by method and URL (query aside), records every call, refuses an unknown one. */
function createVendor() {
  const calls: VendorCall[] = [];
  const handlers = new Map<string, Handler>();
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: VendorCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    };
    calls.push(call);
    const handler = handlers.get(`${call.method} ${call.url.split('?')[0]}`);
    if (!handler) throw new Error(`unexpected vendor call: ${call.method} ${call.url}`);
    return handler(call, init?.signal ?? undefined);
  }) as typeof fetch;
  return {
    fetchFn,
    calls,
    on: (method: string, vendorUrl: string, handler: Handler) =>
      void handlers.set(`${method} ${vendorUrl}`, handler),
    count: (method: string, vendorUrl: string) =>
      calls.filter((c) => c.method === method && c.url.split('?')[0] === vendorUrl).length,
  };
}
type Vendor = ReturnType<typeof createVendor>;

/** An authorization server: consent mints a code bound to its PKCE challenge, redirect and client. */
function installOauthVendor(
  vendor: Vendor,
  o: {
    prefix: string;
    tokenUrl: string;
    deviceUrl: string;
    meUrl: string;
    verificationUri: string;
    revokeUrl?: string;
    clientId: string;
    clientSecret: string;
    scopeSeparator: ' ' | ',';
    errorStatus: number;
    expiring: boolean;
    me: (account: Account) => Record<string, unknown>;
  },
) {
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; scope: string; used: boolean }
  >();
  const devices = new Map<string, string>();
  const accessTokens = new Set<string>();
  let seq = 0;
  const control = {
    clientId: o.clientId,
    account: { id: '1001', label: 'user-a@stub.test' } as Account,
    expiring: o.expiring,
    tokenDelayMs: 0,
    revokeStatus: 200,
    devicePolls: 0,
    deviceCodes: [] as string[],
    onDevicePoll: (_poll: number): DeviceAnswer => 'approve',
    issued: [] as { access: string; refresh: string | null }[],
    approve(authorizeUrl: string) {
      const params = new URL(authorizeUrl).searchParams;
      seq += 1;
      const code = `stub-auth-code-${seq}`;
      codes.set(code, {
        challenge: params.get('code_challenge') ?? '',
        redirectUri: params.get('redirect_uri') ?? '',
        clientId: params.get('client_id') ?? '',
        scope: params.get('scope') ?? '',
        used: false,
      });
      return { code, state: params.get('state') ?? '' };
    },
  };
  const issue = (scope: string) => {
    seq += 1;
    const access = `${o.prefix}-access-${seq}`;
    const refresh = control.expiring ? `${o.prefix}-refresh-${seq}` : null;
    accessTokens.add(access);
    control.issued.push({ access, refresh });
    return json(200, {
      access_token: access,
      token_type: 'bearer',
      scope: scope.split(' ').join(o.scopeSeparator),
      ...(refresh === null ? {} : { refresh_token: refresh, expires_in: 3600 }),
    });
  };
  const oauthError = (error: string, extra: Record<string, unknown> = {}) =>
    json(o.errorStatus, { error, ...extra });

  vendor.on('POST', o.tokenUrl, async (call, signal) => {
    if (control.tokenDelayMs > 0) await sleep(control.tokenDelayMs);
    if (call.form.grant_type === 'authorization_code') {
      const entry = codes.get(call.form.code ?? '');
      if (!entry || entry.used) return oauthError('invalid_grant');
      entry.used = true;
      const proven =
        sha256(call.form.code_verifier ?? '') === entry.challenge &&
        call.form.redirect_uri === entry.redirectUri &&
        call.form.client_id === entry.clientId &&
        call.form.client_id === control.clientId &&
        call.form.client_secret === o.clientSecret;
      return proven ? issue(entry.scope) : oauthError('invalid_grant');
    }
    if (call.form.grant_type === DEVICE_GRANT) {
      const scope = devices.get(call.form.device_code ?? '');
      if (scope === undefined || call.form.client_id !== control.clientId) {
        return oauthError('incorrect_device_code');
      }
      control.devicePolls += 1;
      switch (control.onDevicePoll(control.devicePolls)) {
        case 'pending':
          return oauthError('authorization_pending');
        case 'slow_down':
          return oauthError('slow_down', { interval: 10 });
        case 'access_denied':
          return oauthError('access_denied');
        case 'expired_token':
          return oauthError('expired_token');
        case 'unavailable':
          return new Response('', { status: 503 });
        case 'hang':
          return hang(call, signal);
        case 'approve':
          return issue(scope);
      }
    }
    return oauthError('unsupported_grant_type');
  });
  vendor.on('POST', o.deviceUrl, (call) => {
    if (call.form.client_id !== control.clientId) return oauthError('incorrect_client_credentials');
    seq += 1;
    const deviceCode = `stub-device-code-${seq}`;
    devices.set(deviceCode, call.form.scope ?? '');
    control.deviceCodes.push(deviceCode);
    return json(200, {
      device_code: deviceCode,
      user_code: 'WDJB-MJHT',
      verification_uri: o.verificationUri,
      expires_in: 900,
      interval: 5,
    });
  });
  vendor.on('GET', o.meUrl, (call) => {
    const token = /^Bearer (.+)$/.exec(call.headers.Authorization ?? '')?.[1];
    return token && accessTokens.has(token)
      ? json(200, o.me(control.account))
      : json(401, { message: 'Bad credentials' });
  });
  if (o.revokeUrl) {
    vendor.on('POST', o.revokeUrl, () => new Response('', { status: control.revokeStatus }));
  }
  return control;
}
type OauthVendor = ReturnType<typeof installOauthVendor>;

interface TestUser {
  id: string;
  cookie: string;
}
interface Reply {
  status: number;
  body: Body;
  text: string;
}

describe.skipIf(!url || !redisUrl)('integration broker routes on Postgres and Redis', () => {
  let db: Database;
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  let vendor: Vendor;
  let stub: OauthVendor;
  let github: OauthVendor;
  let a: TestUser;
  let b: TestUser;
  let userIds: string[] = [];

  async function createUser(role: 'user' | 'admin' = 'user'): Promise<TestUser> {
    const [row] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'broker-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role,
        status: 'active',
        tokenVersion: 0,
      })
      .returning({ id: schema.users.id });
    userIds.push(row!.id);
    const token = await signAccessToken({ sub: row!.id, role, tv: 0 });
    return { id: row!.id, cookie: `${ACCESS_COOKIE}=${token}` };
  }

  /** A header set to null is left off, so a request can come with no Origin at all. */
  async function call(
    user: TestUser | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string | null> = {},
  ): Promise<Reply> {
    const sent: Record<string, string> = {
      host: 'localhost:3001',
      origin: APP_ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(user ? { cookie: user.cookie } : {}),
    };
    for (const [name, value] of Object.entries(headers)) {
      if (value === null) delete sent[name];
      else sent[name] = value;
    }
    const res = await app.request(path, {
      method,
      headers: sent,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    for (const marker of SECRET_MARKERS) {
      expect(text.includes(marker), `a ${method} ${path} response carried a credential`).toBe(
        false,
      );
    }
    return { status: res.status, body: jsonOrEmpty(text), text };
  }

  const connect = (user: TestUser, providerId = STUB_ID) =>
    call(user, 'POST', `/integrations/providers/${providerId}/connect`, {});
  const complete = (user: TestUser, body: unknown, headers?: Record<string, string | null>) =>
    call(user, 'POST', '/integrations/oauth/complete', body, headers);
  const startDevice = (user: TestUser, providerId = STUB_ID) =>
    call(user, 'POST', `/integrations/providers/${providerId}/device/start`, {});
  const pollDevice = (user: TestUser, handle: string, providerId = STUB_ID) =>
    call(user, 'POST', `/integrations/providers/${providerId}/device/poll`, { handle });
  const setWrite = (user: TestUser, providerId: string, writeEnabled: boolean) =>
    call(user, 'PUT', `/integrations/providers/${providerId}/write`, { writeEnabled });
  /** Time only moves when a test moves it, so a poll interval is crossed on purpose. */
  const wait = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);

  /** Connect, then act as the vendor's consent screen: the user ends up holding a code and the state. */
  async function consent(user: TestUser, providerId = STUB_ID, server: OauthVendor = stub) {
    const res = await connect(user, providerId);
    expect(res.status).toBe(200);
    return {
      ...server.approve(res.body.authorizeUrl as string),
      authorizeUrl: res.body.authorizeUrl,
    };
  }

  async function signInWithCode(user: TestUser) {
    const { code, state } = await consent(user);
    return complete(user, { providerId: STUB_ID, state, code });
  }

  async function signInWithDevice(user: TestUser, providerId = 'github') {
    const started = await startDevice(user, providerId);
    expect(started.status).toBe(200);
    wait(5);
    return pollDevice(user, started.body.handle as string, providerId);
  }

  const connectionsOf = (userId: string) =>
    db
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.ownerUserId, userId))
      .orderBy(asc(schema.integrationConnections.createdAt));
  const credentialsOf = (userId: string) =>
    db
      .select()
      .from(schema.repoCredentials)
      .where(eq(schema.repoCredentials.userId, userId))
      .orderBy(asc(schema.repoCredentials.createdAt));
  const auditsOf = async (userId: string, action: string) =>
    (
      await db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.actorUserId, userId))
        .orderBy(asc(schema.auditEvents.createdAt))
    ).filter((row) => row.action === action);
  const oauthKeyOf = (userId: string, providerId = STUB_ID) =>
    `integration-oauth:${userId}:${providerId}`;
  const deviceKeyOf = (userId: string, providerId = STUB_ID) =>
    `integration-device:${userId}:${providerId}`;
  const secretOf = (cred: typeof schema.repoCredentials.$inferSelect) =>
    envelopeDecrypt({ encryptedValue: cred.secretEncrypted, encryptedDek: cred.encryptedDek }, KEK);
  const usernameOf = (cred: typeof schema.repoCredentials.$inferSelect) =>
    envelopeDecrypt(
      { encryptedValue: cred.usernameEncrypted, encryptedDek: cred.encryptedDek },
      KEK,
    );

  async function insertCredential(
    userId: string,
    over: Partial<typeof schema.repoCredentials.$inferInsert> = {},
  ) {
    const dek = generateDek();
    const [row] = await db
      .insert(schema.repoCredentials)
      .values({
        userId,
        label: 'Seeded credential',
        host: 'github.com',
        usernameEncrypted: encrypt('seeded-user', dek),
        secretEncrypted: encrypt('seeded-secret', dek),
        encryptedDek: encryptDek(dek, KEK),
        ...over,
      })
      .returning();
    return row!;
  }

  async function configureStub(
    over: Partial<typeof schema.integrationProviderConfigs.$inferInsert> = {},
  ) {
    const envelope = envelopeEncrypt(ADMIN_CLIENT.secret, KEK);
    const values = {
      providerId: STUB_ID,
      enabled: true,
      oauthClientId: ADMIN_CLIENT.id,
      oauthClientSecretEncrypted: envelope.encryptedValue,
      encryptedDek: envelope.encryptedDek,
      ...over,
    };
    await db
      .insert(schema.integrationProviderConfigs)
      .values(values)
      .onConflictDoUpdate({ target: schema.integrationProviderConfigs.providerId, set: values });
  }

  async function replaceStubClient(clientId: string) {
    await configureStub({ oauthClientId: clientId });
    stub.clientId = clientId;
  }

  function useGithubClient(withSecret = false) {
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', GITHUB_CLIENT.id);
    vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', withSecret ? GITHUB_CLIENT.secret : '');
  }

  /** Replies come back late, as over a network, so a check and an act sent as two commands are caught between them. */
  function delayRedisReplies(ms: number) {
    const redis = getRedis();
    const send = redis.sendCommand.bind(redis);
    vi.spyOn(redis, 'sendCommand').mockImplementation(((...args: Parameters<typeof send>) =>
      Promise.resolve(send(...args)).then(async (reply) => {
        await sleep(ms);
        return reply;
      })) as typeof send);
  }

  /** Every `AbortSignal.timeout` a route asks for is shortened to 100 ms; the asked-for values come back. */
  function shortenTimeouts() {
    const requested: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      requested.push(ms);
      return real(100);
    });
    return requested;
  }

  async function cleanup() {
    const redis = getRedis();
    for (const id of userIds) {
      const keys = await redis.keys(`integration-*:${id}:*`);
      if (keys.length > 0) await redis.del(...keys);
    }
    if (userIds.length > 0) {
      await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.actorUserId, userIds));
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await db.delete(schema.integrationProviderConfigs);
    userIds = [];
  }

  beforeAll(async () => {
    db = initDatabase(url as string);
    initRedis(redisUrl as string);
    await userSecretsService.initialize(db, KEK);
    const { createApiApp } = await import('../src/index.js');
    app = createApiApp(APP_ORIGIN);
  });

  beforeEach(async () => {
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue(JWT_SECRET);
    vi.stubEnv('WEB_ORIGIN', APP_ORIGIN);
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
    vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', '');
    vendor = createVendor();
    vi.stubGlobal('fetch', vendor.fetchFn);
    stub = installOauthVendor(vendor, {
      prefix: 'tok-stub',
      tokenUrl: STUB.token,
      deviceUrl: STUB.device,
      meUrl: STUB.me,
      verificationUri: 'https://stub.example.test/device',
      revokeUrl: STUB.revoke,
      clientId: ADMIN_CLIENT.id,
      clientSecret: ADMIN_CLIENT.secret,
      scopeSeparator: ' ',
      errorStatus: 400,
      expiring: true,
      me: (account) => ({ id: account.id, email: account.label }),
    });
    github = installOauthVendor(vendor, {
      prefix: 'tok-gh',
      tokenUrl: GITHUB.token,
      deviceUrl: GITHUB.device,
      meUrl: GITHUB.me,
      verificationUri: 'https://github.com/login/device',
      clientId: GITHUB_CLIENT.id,
      clientSecret: GITHUB_CLIENT.secret,
      scopeSeparator: ',',
      errorStatus: 200,
      expiring: false,
      me: (account) => ({ id: Number(account.id), login: account.label }),
    });
    github.account = { id: '583231', label: 'octocat' };
    await configureStub();
    a = await createUser();
    b = await createUser();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (userIds.length > 0) {
      const audits = await db
        .select()
        .from(schema.auditEvents)
        .where(inArray(schema.auditEvents.actorUserId, userIds));
      for (const row of audits) {
        const text = JSON.stringify(row);
        for (const marker of SECRET_MARKERS) {
          expect(text.includes(marker), `audit event ${row.action} carried a credential`).toBe(
            false,
          );
        }
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await cleanup();
  });

  afterAll(async () => {
    await closeRedis();
    await db.$client.end({ timeout: 5 });
  });

  describe('OAuth code flow', () => {
    it('connect hands back an authorize URL with S256 PKCE, a state and the web callback as redirect', async () => {
      const res = await connect(a);
      expect(res.status).toBe(200);
      const authorize = new URL(res.body.authorizeUrl as string);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(STUB.authorize);
      const query = authorize.searchParams;
      expect(query.get('response_type')).toBe('code');
      expect(query.get('client_id')).toBe(ADMIN_CLIENT.id);
      expect(query.get('redirect_uri')).toBe(
        `${APP_ORIGIN}/settings/integrations/callback/${STUB_ID}`,
      );
      expect(query.get('code_challenge_method')).toBe('S256');
      expect(query.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(query.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(query.get('scope')).toBe('files.read');
      expect(vendor.calls).toHaveLength(0);

      const keys = await getRedis().keys(`integration-oauth:${a.id}:*`);
      expect(keys).toEqual([oauthKeyOf(a.id)]);
      const ttl = await getRedis().ttl(oauthKeyOf(a.id));
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    it("connect adds the provider's own authorize parameters after the OAuth ones", async () => {
      const res = await connect(a);

      expect(res.status).toBe(200);
      const query = new URL(res.body.authorizeUrl as string).searchParams;
      expect([...query.keys()]).toEqual([
        'response_type',
        'client_id',
        'redirect_uri',
        'scope',
        'state',
        'code_challenge',
        'code_challenge_method',
        'access_type',
        'prompt',
      ]);
      expect(query.get('access_type')).toBe('offline');
      expect(query.get('prompt')).toBe('consent');
    });

    it('complete as the same user stores one connection with encrypted tokens and makes one token call', async () => {
      const res = await signInWithCode(a);

      expect(res.status).toBe(200);
      expect(vendor.count('POST', STUB.token)).toBe(1);
      expect(vendor.count('GET', STUB.me)).toBe(1);
      const rows = await connectionsOf(a.id);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        providerId: STUB_ID,
        scope: 'user',
        accountLabel: 'user-a@stub.test',
        externalAccountId: '1001',
        authMethod: 'oauth2',
        status: 'connected',
        repoCredentialId: null,
        grantedScopes: ['files.read'],
        oauthClientId: ADMIN_CLIENT.id,
      });
      expect(row.expiresAt).not.toBeNull();
      const issued = stub.issued[0]!;
      expect(JSON.stringify(row)).not.toContain(issued.access);
      expect(JSON.stringify(row)).not.toContain(issued.refresh!);
      expect(decryptConnectionTokens(row, KEK)).toEqual({
        accessToken: issued.access,
        refreshToken: issued.refresh,
      });
      expect(res.body.connection).toMatchObject({
        id: row.id,
        providerId: STUB_ID,
        accountLabel: 'user-a@stub.test',
        authMethod: 'oauth2',
        status: 'connected',
      });
      expect(await getRedis().keys(`integration-oauth:${a.id}:*`)).toEqual([]);
      const [event] = await auditsOf(a.id, 'integration.connection.create');
      expect(event).toMatchObject({ targetType: 'integration_connection', targetId: row.id });
      expect(event!.metadata).toMatchObject({ providerId: STUB_ID, authMethod: 'oauth2' });
    });

    it('a replay of the same state and code is refused: still one connection and one token call', async () => {
      const { code, state } = await consent(a);
      expect((await complete(a, { providerId: STUB_ID, state, code })).status).toBe(200);
      const replay = await complete(a, { providerId: STUB_ID, state, code });

      expect(replay.status).toBe(400);
      expect(replay.body.error).toMatch(INVALID_STATE);
      expect(await connectionsOf(a.id)).toHaveLength(1);
      expect(vendor.count('POST', STUB.token)).toBe(1);
    });

    it('ten simultaneous completions of one state make exactly one token call and one connection', async () => {
      const { code, state } = await consent(a);
      stub.tokenDelayMs = 120;
      delayRedisReplies(40);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => complete(a, { providerId: STUB_ID, state, code })),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(9);
      expect(vendor.count('POST', STUB.token)).toBe(1);
      expect(await connectionsOf(a.id)).toHaveLength(1);
    });

    it("another user's session cannot complete a state minted for the first, and consumes nothing", async () => {
      const { code, state } = await consent(a);
      const foreign = await complete(b, { providerId: STUB_ID, state, code });

      expect(foreign.status).toBe(400);
      expect(foreign.body.error).toMatch(INVALID_STATE);
      expect(await connectionsOf(b.id)).toHaveLength(0);
      expect(vendor.calls).toHaveLength(0);

      const own = await complete(a, { providerId: STUB_ID, state, code });
      expect(own.status).toBe(200);
      expect(await connectionsOf(a.id)).toHaveLength(1);
      expect(await connectionsOf(b.id)).toHaveLength(0);
    });

    it('a different state in the right session is refused and leaves the attempt usable', async () => {
      const { code, state } = await consent(a);
      const wrong = await complete(a, {
        providerId: STUB_ID,
        state: randomBytes(32).toString('base64url'),
        code,
      });

      expect(wrong.status).toBe(400);
      expect(vendor.calls).toHaveLength(0);
      expect(await getRedis().exists(oauthKeyOf(a.id))).toBe(1);
      expect((await complete(a, { providerId: STUB_ID, state, code })).status).toBe(200);
    });

    it('a state minted for one provider cannot be completed on another provider path', async () => {
      const { code, state } = await consent(a);
      const res = await complete(a, { providerId: 'github', state, code });

      expect(res.status).toBe(400);
      expect(vendor.calls).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
      expect((await complete(a, { providerId: STUB_ID, state, code })).status).toBe(200);
    });

    it('an expired attempt is refused before any vendor call', async () => {
      const { code, state } = await consent(a);
      await getRedis().pexpire(oauthKeyOf(a.id), 1);
      await sleep(20);
      const res = await complete(a, { providerId: STUB_ID, state, code });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(INVALID_STATE);
      expect(vendor.calls).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('an unknown state is refused before any vendor call', async () => {
      const res = await complete(a, {
        providerId: STUB_ID,
        state: randomBytes(32).toString('base64url'),
        code: 'stub-auth-code-unknown',
      });

      expect(res.status).toBe(400);
      expect(vendor.calls).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('an error from the vendor consumes the attempt, writes nothing and calls nothing', async () => {
      const { code, state } = await consent(a);
      const denied = await complete(a, { providerId: STUB_ID, state, error: 'access_denied' });

      expect(denied.status).toBe(400);
      expect(denied.body.error).toContain('access_denied');
      expect(vendor.calls).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
      expect(await getRedis().exists(oauthKeyOf(a.id))).toBe(0);
      expect((await complete(a, { providerId: STUB_ID, state, code })).status).toBe(400);
      expect(vendor.calls).toHaveLength(0);
    });

    it('a vendor error carrying the wrong state consumes nothing', async () => {
      await consent(a);
      const forged = await complete(a, {
        providerId: STUB_ID,
        state: randomBytes(32).toString('base64url'),
        error: 'access_denied',
      });

      expect(forged.status).toBe(400);
      expect(await getRedis().exists(oauthKeyOf(a.id))).toBe(1);
    });

    it('a body with both or neither of code and error is refused without touching the attempt', async () => {
      const { code, state } = await consent(a);
      const both = await complete(a, { providerId: STUB_ID, state, code, error: 'access_denied' });
      const neither = await complete(a, { providerId: STUB_ID, state });

      expect(both.status).toBe(400);
      expect(neither.status).toBe(400);
      expect(await getRedis().exists(oauthKeyOf(a.id))).toBe(1);
    });

    it('a failed token exchange writes nothing and the attempt is spent', async () => {
      const { state } = await consent(a);
      const res = await complete(a, { providerId: STUB_ID, state, code: 'stub-auth-code-bad' });

      expect(res.status).toBe(400);
      expect(vendor.count('POST', STUB.token)).toBe(1);
      expect(await connectionsOf(a.id)).toHaveLength(0);
      expect(await getRedis().exists(oauthKeyOf(a.id))).toBe(0);
    });

    it('a vendor that is down answers 502 and writes nothing', async () => {
      const { code, state } = await consent(a);
      vendor.on('POST', STUB.token, () => new Response('', { status: 503 }));
      const res = await complete(a, { providerId: STUB_ID, state, code });

      expect(res.status).toBe(502);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('a client replaced between connect and complete is refused before the vendor is called', async () => {
      const { code, state } = await consent(a);
      await configureStub({ oauthClientId: 'stub-admin-client-id-2' });
      const res = await complete(a, { providerId: STUB_ID, state, code });

      expect(res.status).toBe(400);
      expect(vendor.calls).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('a provider disabled between connect and complete is refused before the vendor is called', async () => {
      const { code, state } = await consent(a);
      await configureStub({ enabled: false });
      const res = await complete(a, { providerId: STUB_ID, state, code });

      expect(res.status).toBe(403);
      expect(vendor.calls).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('a later connect replaces the earlier attempt: one key per user and provider', async () => {
      const first = await consent(a);
      const second = await consent(a);

      expect(await getRedis().keys(`integration-oauth:${a.id}:*`)).toEqual([oauthKeyOf(a.id)]);
      const stale = { providerId: STUB_ID, state: first.state, code: first.code };
      expect((await complete(a, stale)).status).toBe(400);
      const latest = { providerId: STUB_ID, state: second.state, code: second.code };
      expect((await complete(a, latest)).status).toBe(200);
    });

    it('signing in again to the same account updates the row in place', async () => {
      expect((await signInWithCode(a)).status).toBe(200);
      const [before] = await connectionsOf(a.id);
      const again = await signInWithCode(a);

      expect(again.status).toBe(200);
      const rows = await connectionsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(before!.id);
      expect(decryptConnectionTokens(rows[0]!, KEK).accessToken).toBe(stub.issued[1]!.access);
      expect(rows[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
      expect(await auditsOf(a.id, 'integration.connection.create')).toHaveLength(1);
      expect(await auditsOf(a.id, 'integration.connection.reconnect')).toHaveLength(1);
    });

    it('signing in again with no new refresh token keeps the stored one under the new access token', async () => {
      expect((await signInWithCode(a)).status).toBe(200);
      stub.expiring = false;
      expect((await signInWithCode(a)).status).toBe(200);

      const rows = await connectionsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(stub.issued[1]!.refresh).toBeNull();
      expect(decryptConnectionTokens(rows[0]!, KEK)).toEqual({
        accessToken: stub.issued[1]!.access,
        refreshToken: stub.issued[0]!.refresh,
      });
    });

    it('signing in again with a new refresh token replaces the stored one', async () => {
      expect((await signInWithCode(a)).status).toBe(200);
      expect((await signInWithCode(a)).status).toBe(200);

      const rows = await connectionsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(stub.issued[1]!.refresh).not.toBe(stub.issued[0]!.refresh);
      expect(decryptConnectionTokens(rows[0]!, KEK)).toEqual({
        accessToken: stub.issued[1]!.access,
        refreshToken: stub.issued[1]!.refresh,
      });
    });

    it('signing in again still works when the stored tokens cannot be read, and then holds no refresh token', async () => {
      expect((await signInWithCode(a)).status).toBe(200);
      const [before] = await connectionsOf(a.id);
      await db
        .update(schema.integrationConnections)
        .set({ encryptedDek: encryptDek(generateDek(), 'cd'.repeat(32)) })
        .where(eq(schema.integrationConnections.id, before!.id));
      stub.expiring = false;
      const again = await signInWithCode(a);

      expect(again.status).toBe(200);
      const rows = await connectionsOf(a.id);
      expect(rows.map((row) => row.id)).toEqual([before!.id]);
      expect(decryptConnectionTokens(rows[0]!, KEK)).toEqual({
        accessToken: stub.issued[1]!.access,
        refreshToken: null,
      });
    });

    it('signing in again under another OAuth client keeps no refresh token the first client issued', async () => {
      expect((await signInWithCode(a)).status).toBe(200);
      await replaceStubClient(SECOND_CLIENT_ID);
      stub.expiring = false;
      expect((await signInWithCode(a)).status).toBe(200);

      const rows = await connectionsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.oauthClientId).toBe(SECOND_CLIENT_ID);
      expect(decryptConnectionTokens(rows[0]!, KEK)).toEqual({
        accessToken: stub.issued[1]!.access,
        refreshToken: null,
      });
    });

    it('signing in again under another OAuth client stores the refresh token that client sent', async () => {
      expect((await signInWithCode(a)).status).toBe(200);
      await replaceStubClient(SECOND_CLIENT_ID);
      expect((await signInWithCode(a)).status).toBe(200);

      const rows = await connectionsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.oauthClientId).toBe(SECOND_CLIENT_ID);
      expect(stub.issued[1]!.refresh).not.toBe(stub.issued[0]!.refresh);
      expect(decryptConnectionTokens(rows[0]!, KEK)).toEqual({
        accessToken: stub.issued[1]!.access,
        refreshToken: stub.issued[1]!.refresh,
      });
    });

    it('a sign-in to another account of the same user is a second connection', async () => {
      await signInWithCode(a);
      stub.account = { id: '2002', label: 'user-a-second@stub.test' };
      await signInWithCode(a);

      expect((await connectionsOf(a.id)).map((r) => r.accountLabel)).toEqual([
        'user-a@stub.test',
        'user-a-second@stub.test',
      ]);
    });

    it('requests the write scopes too once the write switch is on', async () => {
      expect((await setWrite(a, STUB_ID, true)).status).toBe(200);
      const res = await connect(a);

      expect(new URL(res.body.authorizeUrl as string).searchParams.get('scope')).toBe(
        'files.read files.write',
      );
    });

    it('connect is refused for an unknown provider, one without the method, a disabled one and a missing client', async () => {
      expect((await connect(a, 'nosuchprovider')).status).toBe(404);
      expect((await connect(a, 'gitea')).status).toBe(400);

      await configureStub({ enabled: false });
      expect((await connect(a)).status).toBe(403);

      await configureStub({ enabled: true, oauthClientId: null });
      expect((await connect(a)).status).toBe(503);

      await configureStub({
        oauthClientId: ADMIN_CLIENT.id,
        oauthClientSecretEncrypted: null,
        encryptedDek: null,
      });
      expect((await connect(a)).status).toBe(503);
      expect(vendor.calls).toHaveLength(0);
      expect(await getRedis().keys(`integration-oauth:${a.id}:*`)).toEqual([]);
    });

    it('every route wants a signed-in user', async () => {
      const attempts = [
        ['POST', `/integrations/providers/${STUB_ID}/connect`],
        ['POST', '/integrations/oauth/complete'],
        ['POST', `/integrations/providers/${STUB_ID}/device/start`],
        ['POST', `/integrations/providers/${STUB_ID}/device/poll`],
        ['GET', '/integrations/providers'],
        ['GET', '/integrations/connections'],
        ['DELETE', `/integrations/connections/${randomUUID()}`],
        ['PUT', `/integrations/providers/${STUB_ID}/write`],
        ['POST', '/integrations/providers/github/link-credential'],
        ['GET', '/integrations/github'],
        ['POST', '/github-oauth/device-code'],
        ['POST', '/github-oauth/poll'],
        ['GET', '/github-oauth/repos'],
      ] as const;
      for (const [method, path] of attempts) {
        const res = await call(null, method, path, method === 'GET' ? undefined : {});
        expect(res.status, `${method} ${path}`).toBe(401);
      }
      expect(vendor.calls).toHaveLength(0);
    });
  });

  describe('where a request may come from', () => {
    it('complete and connect from another page are refused by the global origin check', async () => {
      const { code, state } = await consent(a);
      const foreign = { origin: 'http://evil.example' };
      const completed = await complete(a, { providerId: STUB_ID, state, code }, foreign);
      const connected = await call(
        a,
        'POST',
        `/integrations/providers/${STUB_ID}/connect`,
        {},
        foreign,
      );

      expect(completed.status).toBe(403);
      expect(completed.body.error).toBe('Refused a request from another page');
      expect(connected.status).toBe(403);
      expect(vendor.calls).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
      expect((await complete(a, { providerId: STUB_ID, state, code })).status).toBe(200);
    });

    it('a request with no Origin, such as a script, is not a foreign page', async () => {
      const { code, state } = await consent(a);
      const res = await complete(a, { providerId: STUB_ID, state, code }, { origin: null });

      expect(res.status).toBe(200);
    });

    it('there is no state-changing GET: a GET to complete is no route and writes nothing', async () => {
      const { code, state } = await consent(a);
      const res = await call(a, 'GET', `/integrations/oauth/complete?state=${state}&code=${code}`);

      expect(res.status).toBe(404);
      expect(vendor.calls).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });
  });

  describe('device flow, generic', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    it('start returns a handle and the user code, never the device code', async () => {
      const res = await startDevice(a);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'expiresIn',
        'handle',
        'interval',
        'userCode',
        'verificationUri',
      ]);
      expect(res.body).toMatchObject({
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://stub.example.test/device',
        expiresIn: 900,
        interval: 5,
      });
      expect(res.body.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.body.handle).not.toBe(stub.deviceCodes[0]);
      expect(vendor.calls[0]!.form).toEqual({ client_id: ADMIN_CLIENT.id, scope: 'files.read' });
      expect(await getRedis().keys(`integration-device:${a.id}:*`)).toEqual([deviceKeyOf(a.id)]);
      const ttl = await getRedis().ttl(deviceKeyOf(a.id));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    });

    it('only the user who started a sign-in can poll it: another user costs no vendor call', async () => {
      const { body } = await startDevice(a);
      wait(5);
      const foreign = await pollDevice(b, body.handle);

      expect(foreign.status).toBe(400);
      expect(vendor.count('POST', STUB.token)).toBe(0);
      expect(await connectionsOf(b.id)).toHaveLength(0);

      const own = await pollDevice(a, body.handle);
      expect(own.status).toBe(200);
      expect(own.body.status).toBe('ok');
      expect(await connectionsOf(b.id)).toHaveLength(0);
    });

    it("the vendor's device code is not a handle", async () => {
      await startDevice(a);
      wait(5);
      const res = await pollDevice(a, stub.deviceCodes[0]!);

      expect(res.status).toBe(400);
      expect(vendor.count('POST', STUB.token)).toBe(0);
    });

    it('a success stores a connection that owns encrypted tokens and ends the sign-in', async () => {
      const { body } = await startDevice(a);
      wait(5);
      const res = await pollDevice(a, body.handle);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        connection: { providerId: STUB_ID, accountLabel: 'user-a@stub.test', authMethod: 'device' },
      });
      const [row] = await connectionsOf(a.id);
      expect(row).toMatchObject({
        repoCredentialId: null,
        oauthClientId: ADMIN_CLIENT.id,
        grantedScopes: ['files.read'],
      });
      expect(decryptConnectionTokens(row!, KEK)).toEqual({
        accessToken: stub.issued[0]!.access,
        refreshToken: stub.issued[0]!.refresh,
      });
      expect(await getRedis().exists(deviceKeyOf(a.id))).toBe(0);
      expect(await credentialsOf(a.id)).toHaveLength(0);
    });

    it('a device sign-in again with no new refresh token keeps the stored one', async () => {
      const first = await startDevice(a);
      wait(5);
      expect((await pollDevice(a, first.body.handle)).status).toBe(200);
      stub.expiring = false;
      const second = await startDevice(a);
      wait(5);
      expect((await pollDevice(a, second.body.handle)).status).toBe(200);

      const rows = await connectionsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(decryptConnectionTokens(rows[0]!, KEK)).toEqual({
        accessToken: stub.issued[1]!.access,
        refreshToken: stub.issued[0]!.refresh,
      });
    });

    it('signing in again by the web flow keeps no refresh token the device flow issued', async () => {
      expect((await signInWithDevice(a, STUB_ID)).status).toBe(200);
      stub.expiring = false;
      expect((await signInWithCode(a)).status).toBe(200);

      const rows = await connectionsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.authMethod).toBe('oauth2');
      expect(decryptConnectionTokens(rows[0]!, KEK)).toEqual({
        accessToken: stub.issued[1]!.access,
        refreshToken: null,
      });
    });

    it('a poll before the interval has passed is answered locally, without a vendor call', async () => {
      const { body } = await startDevice(a);
      stub.onDevicePoll = (n) => (n === 1 ? 'pending' : 'approve');
      const early = await pollDevice(a, body.handle);
      expect(early.body).toEqual({ status: 'pending', interval: 5 });
      expect(vendor.count('POST', STUB.token)).toBe(0);

      wait(5);
      const first = await pollDevice(a, body.handle);
      expect(first.body).toEqual({ status: 'pending', interval: 5 });
      expect(vendor.count('POST', STUB.token)).toBe(1);

      const again = await pollDevice(a, body.handle);
      expect(again.body.status).toBe('pending');
      expect(vendor.count('POST', STUB.token)).toBe(1);

      wait(5);
      expect((await pollDevice(a, body.handle)).body.status).toBe('ok');
      expect(vendor.count('POST', STUB.token)).toBe(2);
    });

    it('slow_down adds five seconds to the interval, and the longer interval is kept locally', async () => {
      const { body } = await startDevice(a);
      stub.onDevicePoll = (n) => (n === 1 ? 'slow_down' : 'approve');
      wait(5);
      const slowed = await pollDevice(a, body.handle);
      expect(slowed.body).toEqual({ status: 'pending', interval: 10 });

      wait(5);
      expect((await pollDevice(a, body.handle)).body).toEqual({ status: 'pending', interval: 10 });
      expect(vendor.count('POST', STUB.token)).toBe(1);

      wait(5);
      expect((await pollDevice(a, body.handle)).body.status).toBe('ok');
      expect(vendor.count('POST', STUB.token)).toBe(2);
    });

    it.each(['access_denied', 'expired_token'] as const)(
      'a vendor %s ends the sign-in: 400 now, and the handle is gone',
      async (answer) => {
        const { body } = await startDevice(a);
        stub.onDevicePoll = () => answer;
        wait(5);
        const res = await pollDevice(a, body.handle);

        expect(res.status).toBe(400);
        expect(res.body.error).toContain(answer);
        expect(await getRedis().exists(deviceKeyOf(a.id))).toBe(0);
        expect(await connectionsOf(a.id)).toHaveLength(0);
        wait(5);
        expect((await pollDevice(a, body.handle)).status).toBe(400);
        expect(vendor.count('POST', STUB.token)).toBe(1);
      },
    );

    it('a vendor that is down answers 502 and the sign-in stays alive for the next poll', async () => {
      const { body } = await startDevice(a);
      stub.onDevicePoll = (n) => (n === 1 ? 'unavailable' : 'approve');
      wait(5);
      const down = await pollDevice(a, body.handle);
      expect(down.status).toBe(502);
      expect(await getRedis().exists(deviceKeyOf(a.id))).toBe(1);

      wait(5);
      expect((await pollDevice(a, body.handle)).body.status).toBe('ok');
    });

    it('a vendor call that hangs is cut at the vendor timeout and answers 502', async () => {
      const requested = shortenTimeouts();
      const { body } = await startDevice(a);
      stub.onDevicePoll = () => 'hang';
      wait(5);
      const res = await pollDevice(a, body.handle);

      expect(res.status).toBe(502);
      expect(requested).toContain(VENDOR_CALL_TIMEOUT_MS);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('ten simultaneous polls of one handle make one vendor call', async () => {
      const { body } = await startDevice(a);
      stub.tokenDelayMs = 120;
      wait(5);
      delayRedisReplies(40);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => pollDevice(a, body.handle)),
      );

      expect(results.filter((r) => r.body.status === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r.body.status === 'pending')).toHaveLength(9);
      expect(vendor.count('POST', STUB.token)).toBe(1);
      expect(await connectionsOf(a.id)).toHaveLength(1);
    });

    it('starting again replaces the earlier sign-in: one key per user and provider', async () => {
      const first = await startDevice(a);
      const second = await startDevice(a);
      wait(5);

      expect(await getRedis().keys(`integration-device:${a.id}:*`)).toEqual([deviceKeyOf(a.id)]);
      expect((await pollDevice(a, first.body.handle)).status).toBe(400);
      expect((await pollDevice(a, second.body.handle)).body.status).toBe('ok');
    });

    it('is refused for an unknown provider, one without the method, a disabled one and a missing client', async () => {
      expect((await startDevice(a, 'nosuchprovider')).status).toBe(404);
      expect((await startDevice(a, 'gitea')).status).toBe(400);
      expect((await pollDevice(a, 'x', 'gitea')).status).toBe(400);

      await configureStub({ enabled: false });
      expect((await startDevice(a)).status).toBe(403);
      expect((await pollDevice(a, 'x')).status).toBe(403);

      await configureStub({ enabled: true, oauthClientId: null });
      expect((await startDevice(a)).status).toBe(503);
      expect(vendor.calls).toHaveLength(0);
    });

    it('a poll without a handle is a bad request', async () => {
      const res = await call(a, 'POST', `/integrations/providers/${STUB_ID}/device/poll`, {});

      expect(res.status).toBe(400);
    });
  });

  describe('GitHub sign-in', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      useGithubClient();
    });

    it('a device sign-in writes a Git credential and a connection that points at it', async () => {
      const res = await signInWithDevice(a);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(vendor.count('POST', GITHUB.device)).toBe(1);
      expect(vendor.count('POST', GITHUB.token)).toBe(1);
      expect(vendor.count('GET', GITHUB.me)).toBe(1);
      const [credential] = await credentialsOf(a.id);
      expect(credential).toMatchObject({
        label: 'GitHub OAuth (octocat)',
        host: 'github.com',
        provider: 'github',
      });
      expect(usernameOf(credential!)).toBe('octocat');
      expect(secretOf(credential!)).toBe(github.issued[0]!.access);
      expect(credential!.secretEncrypted).not.toContain(github.issued[0]!.access);
      const connections = await connectionsOf(a.id);
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({
        providerId: 'github',
        scope: 'user',
        accountLabel: 'octocat',
        externalAccountId: '583231',
        authMethod: 'device',
        repoCredentialId: credential!.id,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        encryptedDek: null,
        expiresAt: null,
        grantedScopes: ['repo'],
        oauthClientId: GITHUB_CLIENT.id,
        status: 'connected',
      });
      expect(res.body.connection).toMatchObject({
        id: connections[0]!.id,
        repoCredentialId: credential!.id,
      });
      const [event] = await auditsOf(a.id, 'integration.connection.create');
      expect(event!.metadata).toMatchObject({
        providerId: 'github',
        authMethod: 'device',
        repoCredentialId: credential!.id,
      });
    });

    it('the credential and the connection are written in one transaction', async () => {
      await db.execute(
        sql`CREATE OR REPLACE FUNCTION integrations_broker_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'refused by the test'; END $body$`,
      );
      await db.execute(
        sql`CREATE TRIGGER integrations_broker_test_refuse BEFORE INSERT ON integration_connections FOR EACH ROW WHEN (NEW.account_label = 'refuse-this-account') EXECUTE FUNCTION integrations_broker_test_refuse()`,
      );
      try {
        github.account = { id: '9', label: 'refuse-this-account' };
        const res = await signInWithDevice(a);

        expect(res.status).toBe(500);
        expect(await credentialsOf(a.id)).toHaveLength(0);
        expect(await connectionsOf(a.id)).toHaveLength(0);
      } finally {
        await db.execute(
          sql`DROP TRIGGER IF EXISTS integrations_broker_test_refuse ON integration_connections`,
        );
        await db.execute(sql`DROP FUNCTION IF EXISTS integrations_broker_test_refuse()`);
      }
    });

    it('signing in again to the same account updates the connection and the credential in place', async () => {
      expect((await signInWithDevice(a)).body.status).toBe('ok');
      const [credential] = await credentialsOf(a.id);
      const [connection] = await connectionsOf(a.id);
      await db
        .update(schema.repoCredentials)
        .set({
          label: 'My GitHub',
          gitName: 'Ada',
          gitEmail: 'ada@example.test',
          apiBaseUrl: 'https://api.github.example/v3',
        })
        .where(eq(schema.repoCredentials.id, credential!.id));
      await db
        .update(schema.integrationConnections)
        .set({ status: 'needs_reauth', lastError: 'The token was revoked.' })
        .where(eq(schema.integrationConnections.id, connection!.id));
      const [repository] = await db
        .insert(schema.repositories)
        .values({
          userId: a.id,
          name: 'bound-repository',
          source: 'local_path',
          localPath: '/tmp/fake',
          storagePath: '/tmp/fake',
          status: 'ready',
          credentialsSecretId: credential!.id,
        })
        .returning({ id: schema.repositories.id });

      const again = await signInWithDevice(a);

      expect(again.body.status).toBe('ok');
      const credentials = await credentialsOf(a.id);
      expect(credentials).toHaveLength(1);
      expect(credentials[0]).toMatchObject({
        id: credential!.id,
        label: 'My GitHub',
        gitName: 'Ada',
        gitEmail: 'ada@example.test',
        apiBaseUrl: 'https://api.github.example/v3',
        provider: 'github',
        host: 'github.com',
      });
      expect(secretOf(credentials[0]!)).toBe(github.issued[1]!.access);
      expect(usernameOf(credentials[0]!)).toBe('octocat');
      const connections = await connectionsOf(a.id);
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({
        id: connection!.id,
        repoCredentialId: credential!.id,
        status: 'connected',
        lastError: null,
      });
      expect(connections[0]!.updatedAt.getTime()).toBeGreaterThan(connection!.updatedAt.getTime());
      const [bound] = await db
        .select({ credentialsSecretId: schema.repositories.credentialsSecretId })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repository!.id));
      expect(bound!.credentialsSecretId).toBe(credential!.id);
      expect(await auditsOf(a.id, 'integration.connection.create')).toHaveLength(1);
      expect(await auditsOf(a.id, 'integration.connection.reconnect')).toHaveLength(1);
    });

    it('a sign-in to a second GitHub account is a second credential and a second connection', async () => {
      await signInWithDevice(a);
      github.account = { id: '777', label: 'hubot' };
      await signInWithDevice(a);

      expect((await credentialsOf(a.id)).map((c) => c.label)).toEqual([
        'GitHub OAuth (octocat)',
        'GitHub OAuth (hubot)',
      ]);
      expect(await connectionsOf(a.id)).toHaveLength(2);
    });

    it('the same GitHub account signed in by two users is one connection each', async () => {
      await signInWithDevice(a);
      await signInWithDevice(b);

      expect(await connectionsOf(a.id)).toHaveLength(1);
      expect(await connectionsOf(b.id)).toHaveLength(1);
      expect(await credentialsOf(a.id)).toHaveLength(1);
      expect(await credentialsOf(b.id)).toHaveLength(1);
    });

    it('a token response with a refresh token and expiry is refused by name, and nothing is written', async () => {
      github.expiring = true;
      const started = await startDevice(a, 'github');
      wait(5);
      const res = await pollDevice(a, started.body.handle, 'github');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(EXPIRING);
      expect(await credentialsOf(a.id)).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
      expect(vendor.count('GET', GITHUB.me)).toBe(0);
      expect(await getRedis().exists(deviceKeyOf(a.id, 'github'))).toBe(0);
      expect(await auditsOf(a.id, 'integration.connection.create')).toHaveLength(0);
    });

    it('a token response with only an expiry is refused the same way', async () => {
      const started = await startDevice(a, 'github');
      vendor.on('POST', GITHUB.token, () =>
        json(200, {
          access_token: 'tok-gh-access-x',
          token_type: 'bearer',
          scope: 'repo',
          expires_in: 28800,
        }),
      );
      wait(5);
      const res = await pollDevice(a, started.body.handle, 'github');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(EXPIRING);
      expect(await credentialsOf(a.id)).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('the web flow stores the client id, a credential and a connection, and sends the stored verifier and redirect', async () => {
      useGithubClient(true);
      const authorizing = await connect(a, 'github');
      expect(authorizing.status).toBe(200);
      const authorize = new URL(authorizing.body.authorizeUrl as string);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(GITHUB.authorize);
      expect(authorize.searchParams.get('client_id')).toBe(GITHUB_CLIENT.id);
      expect(authorize.searchParams.get('scope')).toBe('repo');
      expect(authorize.searchParams.get('redirect_uri')).toBe(
        `${APP_ORIGIN}/settings/integrations/callback/github`,
      );
      expect([...authorize.searchParams.keys()]).toEqual([
        'response_type',
        'client_id',
        'redirect_uri',
        'scope',
        'state',
        'code_challenge',
        'code_challenge_method',
      ]);
      const { code, state } = github.approve(authorizing.body.authorizeUrl as string);

      const res = await complete(a, { providerId: 'github', state, code });

      expect(res.status).toBe(200);
      const form = vendor.calls.find((c) => c.url === GITHUB.token)!.form;
      expect(form).toMatchObject({
        grant_type: 'authorization_code',
        client_id: GITHUB_CLIENT.id,
        redirect_uri: `${APP_ORIGIN}/settings/integrations/callback/github`,
      });
      const [credential] = await credentialsOf(a.id);
      const [connection] = await connectionsOf(a.id);
      expect(connection).toMatchObject({
        authMethod: 'oauth2',
        oauthClientId: GITHUB_CLIENT.id,
        repoCredentialId: credential!.id,
        accountLabel: 'octocat',
      });
      expect(credential).toMatchObject({ host: 'github.com', provider: 'github' });
      expect(secretOf(credential!)).toBe(github.issued[0]!.access);
    });

    it('the web flow refuses an expiring token the same way and writes nothing', async () => {
      useGithubClient(true);
      github.expiring = true;
      const authorizing = await connect(a, 'github');
      const { code, state } = github.approve(authorizing.body.authorizeUrl as string);
      const res = await complete(a, { providerId: 'github', state, code });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(EXPIRING);
      expect(await credentialsOf(a.id)).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('the web flow needs a client secret: a client id alone cannot start it', async () => {
      useGithubClient(false);

      expect((await connect(a, 'github')).status).toBe(503);
    });

    it('a GitHub device-code request that hangs is cut at the vendor timeout', async () => {
      const requested = shortenTimeouts();
      vendor.on('POST', GITHUB.device, hang);
      const res = await startDevice(a, 'github');

      expect(res.status).toBe(502);
      expect(requested).toContain(VENDOR_CALL_TIMEOUT_MS);
      expect(await getRedis().keys(`integration-device:${a.id}:*`)).toEqual([]);
    });

    it('a GitHub account lookup that hangs is cut at the vendor timeout and writes nothing', async () => {
      const requested = shortenTimeouts();
      const started = await startDevice(a, 'github');
      vendor.on('GET', GITHUB.me, hang);
      wait(5);
      const res = await pollDevice(a, started.body.handle, 'github');

      expect(res.status).toBe(502);
      expect(requested).toContain(VENDOR_CALL_TIMEOUT_MS);
      expect(await credentialsOf(a.id)).toHaveLength(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('needs a GitHub OAuth client', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');

      expect((await startDevice(a, 'github')).status).toBe(503);
      expect(vendor.calls).toHaveLength(0);
    });
  });

  describe('legacy /github-oauth aliases', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      useGithubClient();
    });

    const legacyStart = (user: TestUser) => call(user, 'POST', '/github-oauth/device-code', {});
    const legacyPoll = (user: TestUser, deviceCode: string) =>
      call(user, 'POST', '/github-oauth/poll', { deviceCode });

    it('device-code keeps its response shape and hands out a handle in place of the device code', async () => {
      const res = await legacyStart(a);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'deviceCode',
        'expiresIn',
        'interval',
        'userCode',
        'verificationUri',
      ]);
      expect(res.body).toMatchObject({
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      });
      expect(res.body.deviceCode).not.toBe(github.deviceCodes[0]);
      expect(vendor.calls[0]!.form).toEqual({ client_id: GITHUB_CLIENT.id, scope: 'repo' });
    });

    it('poll keeps its pending and ok shapes, and the credential it reports is the one written', async () => {
      const { body } = await legacyStart(a);
      github.onDevicePoll = (n) => (n === 1 ? 'pending' : 'approve');
      wait(5);
      const pending = await legacyPoll(a, body.deviceCode);
      expect(pending.status).toBe(200);
      expect(pending.body).toEqual({ status: 'pending', error: 'authorization_pending' });

      wait(5);
      const ok = await legacyPoll(a, body.deviceCode);
      expect(ok.status).toBe(200);
      const [credential] = await credentialsOf(a.id);
      expect(ok.body).toEqual({
        status: 'ok',
        credential: { id: credential!.id, label: 'GitHub OAuth (octocat)', host: 'github.com' },
      });
      expect(await connectionsOf(a.id)).toHaveLength(1);
    });

    it('poll by a user who did not start the sign-in is refused without a vendor call', async () => {
      const { body } = await legacyStart(a);
      wait(5);
      const foreign = await legacyPoll(b, body.deviceCode);

      expect(foreign.status).toBe(400);
      expect(vendor.count('POST', GITHUB.token)).toBe(0);
      expect(await credentialsOf(b.id)).toHaveLength(0);
      expect(await connectionsOf(b.id)).toHaveLength(0);
    });

    it("poll with the vendor's own device code is refused", async () => {
      await legacyStart(a);
      wait(5);
      const res = await legacyPoll(a, github.deviceCodes[0]!);

      expect(res.status).toBe(400);
      expect(vendor.count('POST', GITHUB.token)).toBe(0);
    });

    it('a failed sign-in reports the vendor message as before', async () => {
      const { body } = await legacyStart(a);
      github.onDevicePoll = () => 'access_denied';
      wait(5);
      const res = await legacyPoll(a, body.deviceCode);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('access_denied');
    });

    it('answers 503 as before when no GitHub client is configured', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
      const start = await legacyStart(a);
      const poll = await legacyPoll(a, 'x');

      expect(start.status).toBe(503);
      expect(start.body.error).toBe('GitHub OAuth is not configured on this server');
      expect(poll.status).toBe(503);
      expect(vendor.calls).toHaveLength(0);
    });

    it('signs in with the administrator GitHub client when the environment and the user have none', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
      await db.insert(schema.integrationProviderConfigs).values({
        providerId: 'github',
        enabled: true,
        oauthClientId: GITHUB_CLIENT.id,
      });
      const { body } = await legacyStart(a);
      wait(5);
      const ok = await legacyPoll(a, body.deviceCode);

      expect(vendor.calls[0]!.form.client_id).toBe(GITHUB_CLIENT.id);
      expect(ok.body.status).toBe('ok');
      expect((await connectionsOf(a.id))[0]).toMatchObject({ oauthClientId: GITHUB_CLIENT.id });
      const [event] = await auditsOf(a.id, 'integration.connection.create');
      expect(event!.metadata).toMatchObject({ clientSource: 'admin' });
    });

    it('keeps working when an administrator turned the GitHub integration off', async () => {
      await db.insert(schema.integrationProviderConfigs).values({
        providerId: 'github',
        enabled: false,
      });
      const generic = await startDevice(a, 'github');
      const legacy = await legacyStart(a);

      expect(generic.status).toBe(403);
      expect(legacy.status).toBe(200);
    });

    it('a repeat sign-in through the aliases updates the same credential and connection', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const { body } = await legacyStart(a);
        wait(5);
        expect((await legacyPoll(a, body.deviceCode)).body.status).toBe('ok');
      }

      expect(await credentialsOf(a.id)).toHaveLength(1);
      expect(await connectionsOf(a.id)).toHaveLength(1);
    });

    it('repos keeps its response shape and cuts a GitHub call that hangs at the vendor timeout', async () => {
      const credential = await insertCredential(a.id);
      vendor.on('GET', GITHUB.repos, () =>
        json(200, [
          {
            full_name: 'octo/hello',
            clone_url: 'https://github.com/octo/hello.git',
            default_branch: 'main',
            private: false,
            pushed_at: '2026-10-01T00:00:00Z',
          },
        ]),
      );
      const listed = await call(a, 'GET', `/github-oauth/repos?credentialId=${credential.id}`);
      expect(listed.status).toBe(200);
      const { REPOS_PAGE_CAP, REPOS_PER_PAGE } = await import('../src/routes/github-oauth.js');
      expect(listed.body).toEqual({
        repos: [
          {
            fullName: 'octo/hello',
            cloneUrl: 'https://github.com/octo/hello.git',
            defaultBranch: 'main',
            private: false,
            pushedAt: '2026-10-01T00:00:00Z',
          },
        ],
        truncated: false,
        cap: REPOS_PAGE_CAP * REPOS_PER_PAGE,
      });

      const requested = shortenTimeouts();
      vendor.on('GET', GITHUB.repos, hang);
      const hung = await call(a, 'GET', `/github-oauth/repos?credentialId=${credential.id}`);

      expect(hung.status).toBe(502);
      expect(requested).toContain(VENDOR_CALL_TIMEOUT_MS);
    });
  });

  describe('connections', () => {
    it('lists only the caller own connections, with no token columns', async () => {
      await signInWithCode(a);
      stub.account = { id: '3003', label: 'user-b@stub.test' };
      await signInWithCode(b);
      const res = await call(a, 'GET', '/integrations/connections');

      expect(res.status).toBe(200);
      expect(res.body.connections).toHaveLength(1);
      expect(Object.keys(res.body.connections[0]).sort()).toEqual([
        'accountLabel',
        'authMethod',
        'createdAt',
        'expiresAt',
        'grantedScopes',
        'id',
        'lastError',
        'providerId',
        'refreshRefusedAt',
        'repoCredentialId',
        'status',
        'updatedAt',
      ]);
      expect(res.body.connections[0]).toMatchObject({
        providerId: STUB_ID,
        accountLabel: 'user-a@stub.test',
        status: 'connected',
      });
    });

    it('disconnect revokes at the vendor with the client that issued the token, then deletes the row', async () => {
      await signInWithCode(a);
      const [row] = await connectionsOf(a.id);
      const res = await call(a, 'DELETE', `/integrations/connections/${row!.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, revoked: 'yes' });
      expect(await connectionsOf(a.id)).toHaveLength(0);
      expect(vendor.count('POST', STUB.revoke)).toBe(1);
      expect(vendor.calls.find((c) => c.url === STUB.revoke)!.form).toEqual({
        token: stub.issued[0]!.refresh,
        token_type_hint: 'refresh_token',
        client_id: ADMIN_CLIENT.id,
        client_secret: ADMIN_CLIENT.secret,
      });
      const [event] = await auditsOf(a.id, 'integration.connection.disconnect');
      expect(event).toMatchObject({ targetType: 'integration_connection', targetId: row!.id });
      expect(event!.metadata).toMatchObject({ providerId: STUB_ID, revoked: 'yes' });
    });

    it('disconnect deletes the row even when the issuing client is gone, and revokes nothing', async () => {
      await signInWithCode(a);
      await configureStub({ oauthClientId: 'stub-admin-client-id-2' });
      const [row] = await connectionsOf(a.id);
      const res = await call(a, 'DELETE', `/integrations/connections/${row!.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, revoked: 'no' });
      expect(vendor.count('POST', STUB.revoke)).toBe(0);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('disconnect revokes the tokens of a device sign-in too, through the provider revoke endpoint', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await signInWithDevice(a, STUB_ID);
      const [row] = await connectionsOf(a.id);
      const res = await call(a, 'DELETE', `/integrations/connections/${row!.id}`);

      expect(res.body).toEqual({ ok: true, revoked: 'yes' });
      expect(vendor.calls.find((c) => c.url === STUB.revoke)!.form).toMatchObject({
        token: stub.issued[0]!.refresh,
        client_id: ADMIN_CLIENT.id,
      });
    });

    it('disconnect removes a connection whose tokens can no longer be read, and says nothing was revoked', async () => {
      await signInWithCode(a);
      const [row] = await connectionsOf(a.id);
      await db
        .update(schema.integrationConnections)
        .set({ accessTokenEncrypted: 'not:a:ciphertext' })
        .where(eq(schema.integrationConnections.id, row!.id));
      const res = await call(a, 'DELETE', `/integrations/connections/${row!.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, revoked: 'no' });
      expect(await connectionsOf(a.id)).toHaveLength(0);
      expect(vendor.count('POST', STUB.revoke)).toBe(0);
    });

    it('disconnect deletes the row even when the vendor will not revoke', async () => {
      await signInWithCode(a);
      stub.revokeStatus = 503;
      const [row] = await connectionsOf(a.id);
      const res = await call(a, 'DELETE', `/integrations/connections/${row!.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, revoked: 'no' });
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('disconnect of a Git-credential connection deletes only the connection', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      useGithubClient();
      await signInWithDevice(a);
      const [credential] = await credentialsOf(a.id);
      const [connection] = await connectionsOf(a.id);
      const [repository] = await db
        .insert(schema.repositories)
        .values({
          userId: a.id,
          name: 'bound-repository',
          source: 'local_path',
          localPath: '/tmp/fake',
          storagePath: '/tmp/fake',
          status: 'ready',
          credentialsSecretId: credential!.id,
        })
        .returning({ id: schema.repositories.id });
      const callsBefore = vendor.calls.length;

      const res = await call(a, 'DELETE', `/integrations/connections/${connection!.id}`);

      expect(res.body).toEqual({ ok: true, revoked: 'n/a' });
      expect(vendor.calls).toHaveLength(callsBefore);
      expect(await connectionsOf(a.id)).toHaveLength(0);
      expect(await credentialsOf(a.id)).toHaveLength(1);
      expect(secretOf((await credentialsOf(a.id))[0]!)).toBe(github.issued[0]!.access);
      const [bound] = await db
        .select({ credentialsSecretId: schema.repositories.credentialsSecretId })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repository!.id));
      expect(bound!.credentialsSecretId).toBe(credential!.id);
      const [event] = await auditsOf(a.id, 'integration.connection.disconnect');
      expect(event!.metadata).toMatchObject({ providerId: 'github', revoked: 'n/a' });
    });

    it("another user's connection, an unknown id, a non-id and a shared connection are all 404", async () => {
      await signInWithCode(a);
      const [row] = await connectionsOf(a.id);
      const [shared] = await db
        .insert(schema.integrationConnections)
        .values({
          providerId: STUB_ID,
          scope: 'shared',
          ownerUserId: a.id,
          accountLabel: 'shared account',
          authMethod: 'oauth2',
        })
        .returning({ id: schema.integrationConnections.id });

      expect((await call(b, 'DELETE', `/integrations/connections/${row!.id}`)).status).toBe(404);
      expect((await call(a, 'DELETE', `/integrations/connections/${randomUUID()}`)).status).toBe(
        404,
      );
      expect((await call(a, 'DELETE', '/integrations/connections/not-an-id')).status).toBe(404);
      expect((await call(a, 'DELETE', `/integrations/connections/${shared!.id}`)).status).toBe(404);
      expect(await connectionsOf(a.id)).toHaveLength(2);
      expect(vendor.count('POST', STUB.revoke)).toBe(0);
    });
  });

  describe('the write switch', () => {
    it('is off until set, flips in place and is written to the audit log without a secret', async () => {
      const listed = async () =>
        (await call(a, 'GET', '/integrations/providers')).body.providers.find(
          (p: Body) => p.id === STUB_ID,
        );
      expect((await listed()).writeEnabled).toBe(false);

      const on = await setWrite(a, STUB_ID, true);
      expect(on.status).toBe(200);
      expect(on.body).toEqual({ providerId: STUB_ID, writeEnabled: true });
      expect((await listed()).writeEnabled).toBe(true);
      expect((await setWrite(a, STUB_ID, false)).body.writeEnabled).toBe(false);

      const rows = await db
        .select()
        .from(schema.integrationUserSettings)
        .where(eq(schema.integrationUserSettings.userId, a.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ providerId: STUB_ID, writeEnabled: false });
      const events = await auditsOf(a.id, 'integration.write_switch');
      expect(events.map((e) => (e.metadata as Body).writeEnabled)).toEqual([true, false]);
      expect(events[0]!.metadata).toMatchObject({ providerId: STUB_ID });
    });

    it('is per user and per provider', async () => {
      await setWrite(a, STUB_ID, true);
      const other = (await call(b, 'GET', '/integrations/providers')).body.providers.find(
        (p: Body) => p.id === STUB_ID,
      );
      const githubEntry = (await call(a, 'GET', '/integrations/providers')).body.providers.find(
        (p: Body) => p.id === 'github',
      );

      expect(other.writeEnabled).toBe(false);
      expect(githubEntry.writeEnabled).toBe(false);
    });

    it('refuses an unknown provider and a body that is not a boolean, writing nothing', async () => {
      expect((await setWrite(a, 'nosuchprovider', true)).status).toBe(404);
      const bad = await call(a, 'PUT', `/integrations/providers/${STUB_ID}/write`, {
        writeEnabled: 'yes',
      });

      expect(bad.status).toBe(400);
      expect(await db.select().from(schema.integrationUserSettings)).toHaveLength(0);
    });
  });

  describe('Use as connection', () => {
    const link = (user: TestUser, repoCredentialId: unknown, providerId = 'github') =>
      call(user, 'POST', `/integrations/providers/${providerId}/link-credential`, {
        repoCredentialId,
      });

    it('turns a github.com credential with no provider set into a connection, once', async () => {
      const credential = await insertCredential(a.id, { label: 'GitHub OAuth (octocat)' });
      const res = await link(a, credential.id);

      expect(res.status).toBe(201);
      const rows = await connectionsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        providerId: 'github',
        scope: 'user',
        accountLabel: 'GitHub OAuth (octocat)',
        externalAccountId: null,
        authMethod: 'token',
        repoCredentialId: credential.id,
        oauthClientId: null,
        accessTokenEncrypted: null,
        status: 'connected',
      });
      expect(res.body.connection.id).toBe(rows[0]!.id);
      const [event] = await auditsOf(a.id, 'integration.connection.create');
      expect(event!.metadata).toMatchObject({ providerId: 'github', authMethod: 'token' });

      const second = await link(a, credential.id);
      expect(second.status).toBe(409);
      expect(await connectionsOf(a.id)).toHaveLength(1);
      expect(await credentialsOf(a.id)).toHaveLength(1);
    });

    it('is refused while an administrator has the provider turned off', async () => {
      const credential = await insertCredential(a.id);
      await db.insert(schema.integrationProviderConfigs).values({
        providerId: 'github',
        enabled: false,
      });

      expect((await link(a, credential.id)).status).toBe(403);
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('accepts a credential pinned to the provider on any host', async () => {
      const credential = await insertCredential(a.id, {
        host: 'ghe.example.test',
        provider: 'github',
      });

      expect((await link(a, credential.id)).status).toBe(201);
    });

    it("refuses another user's credential, an unknown one and a malformed id", async () => {
      const theirs = await insertCredential(b.id);

      expect((await link(a, theirs.id)).status).toBe(404);
      expect((await link(a, randomUUID())).status).toBe(404);
      expect((await link(a, 'nope')).status).toBe(400);
      expect(await connectionsOf(a.id)).toHaveLength(0);
      expect(await connectionsOf(b.id)).toHaveLength(0);
    });

    it('refuses a credential of another forge and a provider that is not a Git forge', async () => {
      const gitlab = await insertCredential(a.id, { host: 'gitlab.com', provider: 'gitlab' });
      const unknownHost = await insertCredential(a.id, { host: 'git.example.test' });

      expect((await link(a, gitlab.id)).status).toBe(400);
      expect((await link(a, unknownHost.id)).status).toBe(400);
      expect((await link(a, gitlab.id, STUB_ID)).status).toBe(400);
      expect((await link(a, gitlab.id, 'nosuchprovider')).status).toBe(404);
      expect((await link(a, gitlab.id, 'gitlab')).status).toBe(201);
    });

    it.each([
      { providerId: 'gitlab', host: 'gitlab.com' },
      { providerId: 'gitea', host: 'codeberg.org' },
      { providerId: 'bitbucket_cloud', host: 'bitbucket.org' },
    ])(
      'turns a credential on $host with no provider set into a $providerId connection',
      async ({ providerId, host }) => {
        const credential = await insertCredential(a.id, { host });
        const res = await link(a, credential.id, providerId);

        expect(res.status).toBe(201);
        const rows = await connectionsOf(a.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ providerId, repoCredentialId: credential.id });
      },
    );

    it('does not guess the forge of a self-hosted host with no provider set', async () => {
      const credential = await insertCredential(a.id, { host: 'git.example.test' });

      for (const providerId of CORE_FORGES) {
        expect((await link(a, credential.id, providerId)).status).toBe(400);
      }
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });

    it('refuses a credential with no provider for a forge its host does not run', async () => {
      const gitlab = await insertCredential(a.id, { host: 'gitlab.com' });

      for (const providerId of CORE_FORGES.filter((id) => id !== 'gitlab')) {
        expect((await link(a, gitlab.id, providerId)).status).toBe(400);
      }
      expect(await connectionsOf(a.id)).toHaveLength(0);
    });
  });

  describe('provider list and the GitHub client', () => {
    const providersOf = async (user: TestUser) =>
      (await call(user, 'GET', '/integrations/providers')).body.providers as Body[];

    it('lists every registered provider with enablement, the write switch and what can be connected now', async () => {
      const providers = await providersOf(a);
      const byId = new Map(providers.map((p) => [p.id, p]));

      expect(byId.get('github')).toMatchObject({
        displayName: 'GitHub',
        categories: ['forge'],
        enabled: true,
        writeEnabled: false,
        canWrite: true,
        writeScopes: { oauth2: ['repo'], device: ['repo'] },
        connect: [],
      });
      expect(byId.get('gitea')).toMatchObject({ enabled: true, canWrite: true, connect: [] });
      expect(byId.get('gitea')!.writeScopes).toEqual({});
      expect(byId.get(STUB_ID)).toMatchObject({ enabled: true, writeEnabled: false });
      expect(byId.get(STUB_ID)!.writeScopes).toEqual({
        oauth2: ['files.write'],
        device: ['files.write'],
      });
      expect([...byId.get(STUB_ID)!.connect].sort()).toEqual(['device', 'oauth2']);
      expect(JSON.stringify(providers)).not.toContain(ADMIN_CLIENT.id);
    });

    it('offers the device flow for GitHub with a client id, and the web flow only with a secret too', async () => {
      useGithubClient(false);
      expect((await providersOf(a)).find((p) => p.id === 'github')!.connect).toEqual(['device']);

      useGithubClient(true);
      const connect = (await providersOf(a)).find((p) => p.id === 'github')!.connect as string[];
      expect([...connect].sort()).toEqual(['device', 'oauth2']);
    });

    it('a disabled provider offers nothing', async () => {
      await configureStub({ enabled: false });
      const stubbed = (await providersOf(a)).find((p) => p.id === STUB_ID)!;

      expect(stubbed).toMatchObject({ enabled: false, connect: [] });
    });

    it('GET /integrations/github reports whether a client is configured and where it comes from', async () => {
      const read = async () => (await call(a, 'GET', '/integrations/github')).body;
      expect(await read()).toEqual({ configured: false, source: null });

      await db.insert(schema.integrationProviderConfigs).values({
        providerId: 'github',
        enabled: true,
        oauthClientId: 'gh-admin-client-id',
      });
      expect(await read()).toEqual({ configured: true, source: 'admin' });

      const put = await call(a, 'PUT', '/integrations/github', { clientId: 'gh-user-client-id' });
      expect(put.status).toBe(200);
      expect(await read()).toEqual({ configured: true, source: 'user' });

      useGithubClient();
      expect(await read()).toEqual({ configured: true, source: 'env' });

      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
      const cleared = await call(a, 'PUT', '/integrations/github', { clientId: '' });
      expect(cleared.status).toBe(200);
      expect(await read()).toEqual({ configured: true, source: 'admin' });
      expect((await call(b, 'GET', '/integrations/github')).body.source).toBe('admin');
    });

    it('PUT /integrations/github is audited as booleans: a client id was set, or cleared', async () => {
      const put = (clientId: string) => call(a, 'PUT', '/integrations/github', { clientId });
      expect((await put('gh-user-client-id')).status).toBe(200);
      expect((await put('   ')).status).toBe(200);

      const events = await auditsOf(a.id, 'integration.github_client.update');
      expect(events.map((event) => event.metadata)).toEqual([
        { clientIdSet: true },
        { clientIdSet: false },
      ]);
      expect(events[0]).toMatchObject({ targetType: 'integration_provider', targetId: null });
      expect(JSON.stringify(events)).not.toContain('gh-user-client-id');
    });

    it('a PUT /integrations/github that is refused leaves no audit event', async () => {
      const refused = await call(a, 'PUT', '/integrations/github', { clientId: 'x'.repeat(257) });

      expect(refused.status).toBe(400);
      expect(await auditsOf(a.id, 'integration.github_client.update')).toHaveLength(0);
    });
  });
});
