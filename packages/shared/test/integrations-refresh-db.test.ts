import { randomBytes } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, isLockNotAvailable, schema, type Database } from '@haive/database';
import { secretsService } from '../src/config/secrets.service.js';
import { decrypt, decryptDek, envelopeEncrypt } from '../src/crypto/index.js';
import {
  ConnectionNotFoundError,
  NeedsReauthError,
  OauthUnavailableError,
  OauthVendorError,
  encryptConnectionTokens,
  getConnectionAccessToken,
} from '../src/integrations/index.js';

const url = process.env.INTEGRATIONS_REFRESH_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integrations_refresh_test'))
  throw new Error('Use a dedicated integrations_refresh_test database for the refresh tests');

const KEK = 'ab'.repeat(32);
const HOUR = 3_600_000;
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

type ConnectionInsert = typeof schema.integrationConnections.$inferInsert;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (err: unknown) => err,
  );

interface VendorRequest {
  url: string;
  form: Record<string, string>;
}

/** A vendor that honours only the refresh token it issued last, and decides that on arrival,
 *  before its delay: a request carrying a used token gets invalid_grant. */
function createVendor(
  options: {
    delayMs?: number;
    failFirst?: boolean;
    onRequest?: (callNumber: number) => Promise<void>;
  } = {},
) {
  let refresh = 'stub-refresh-0';
  let issued = 0;
  const requests: VendorRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    requests.push({ url: String(input), form });
    let response: Response;
    if (options.failFirst && requests.length === 1) {
      response = new Response('', { status: 503 });
    } else if (form.refresh_token === refresh) {
      issued += 1;
      refresh = `stub-refresh-${issued}`;
      response = json(200, {
        access_token: `stub-access-${issued}`,
        refresh_token: refresh,
        expires_in: 3600,
        token_type: 'bearer',
        scope: 'repo',
      });
    } else {
      response = json(400, {
        error: 'invalid_grant',
        error_description: 'The refresh token was already used.',
      });
    }
    await options.onRequest?.(requests.length);
    await sleep(options.delayMs ?? 0);
    return response;
  }) as typeof fetch;
  return { fetchFn, requests, calls: () => requests.length };
}

/** A fetch that answers every call with `respond()`, counting them. */
function answering(respond: () => Response | Promise<Response>) {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return respond();
  }) as typeof fetch;
  return { fetchFn, calls: () => calls };
}

describe.skipIf(!url)('connection access tokens on Postgres', () => {
  let dbA: Database;
  let dbB: Database;
  let dbC: Database;
  const userIds: string[] = [];

  async function createUser(): Promise<string> {
    const [user] = await dbA
      .insert(schema.users)
      .values({
        emailEncrypted: 'refresh-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    return user!.id;
  }

  async function createConnection(
    over: Partial<ConnectionInsert> & { refreshToken?: string | null } = {},
  ): Promise<string> {
    const { refreshToken = 'stub-refresh-0', ...columns } = over;
    const [row] = await dbA
      .insert(schema.integrationConnections)
      .values({
        providerId: 'github',
        scope: 'user',
        ownerUserId: await createUser(),
        accountLabel: 'octocat',
        externalAccountId: randomBytes(8).toString('hex'),
        authMethod: 'oauth2',
        grantedScopes: ['repo'],
        ...encryptConnectionTokens({ accessToken: 'stub-access-0', refreshToken }, KEK),
        expiresAt: new Date(Date.now() - 60_000),
        ...columns,
      })
      .returning({ id: schema.integrationConnections.id });
    return row!.id;
  }

  const readRow = async (id: string) => {
    const [row] = await dbA
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, id));
    return row!;
  };

  const storedTokens = async (id: string) => {
    const row = await readRow(id);
    const dek = decryptDek(row.encryptedDek!, KEK);
    return {
      access: decrypt(row.accessTokenEncrypted!, dek),
      refresh: row.refreshTokenEncrypted === null ? null : decrypt(row.refreshTokenEncrypted, dek),
    };
  };

  beforeAll(() => {
    dbA = createDatabase(url as string);
    dbB = createDatabase(url as string);
    dbC = createDatabase(url as string);
  });

  beforeEach(() => {
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'stub-client-id');
    vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', 'stub-client-secret');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await dbA.delete(schema.integrationProviderConfigs);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await dbA.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    for (const db of [dbA, dbB, dbC]) await db.$client.end({ timeout: 5 });
  });

  describe('two callers on one expired connection', () => {
    it('make one vendor call from two separate pools, and both get that token', async () => {
      const id = await createConnection();
      let probe: unknown = 'not run';
      const vendor = createVendor({
        delayMs: 400,
        onRequest: async (callNumber) => {
          if (callNumber === 1) {
            probe = await rejection(
              dbC.execute(
                sql`select id from integration_connections where id = ${id} for update nowait`,
              ),
            );
          }
        },
      });
      const settled = await Promise.allSettled([
        getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }),
        getConnectionAccessToken(dbB, id, { fetchFn: vendor.fetchFn }),
      ]);

      expect.soft(vendor.calls()).toBe(1);
      expect.soft(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const [a, b] = settled.map((r) => (r as PromiseFulfilledResult<string>).value);
      expect.soft(a).toBe('stub-access-1');
      expect.soft(b).toBe(a);
      expect.soft(isLockNotAvailable(probe)).toBe(true);
      const row = await readRow(id);
      expect.soft(row.status).toBe('connected');
      expect.soft(row.lastError).toBeNull();
      expect
        .soft(await storedTokens(id))
        .toEqual({ access: 'stub-access-1', refresh: 'stub-refresh-1' });
      expect.soft(Math.abs(row.expiresAt!.getTime() - (Date.now() + HOUR))).toBeLessThan(10_000);
    });

    it('make one vendor call from one pool, and both get that token', async () => {
      const id = await createConnection();
      const vendor = createVendor({ delayMs: 400 });
      const settled = await Promise.allSettled([
        getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }),
        getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }),
      ]);
      expect(vendor.calls()).toBe(1);
      expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const [a, b] = settled.map((r) => (r as PromiseFulfilledResult<string>).value);
      expect(a).toBe('stub-access-1');
      expect(b).toBe(a);
      expect((await readRow(id)).status).toBe('connected');
    });

    it('make one vendor call for four callers across two pools', async () => {
      const id = await createConnection();
      const vendor = createVendor({ delayMs: 300 });
      const settled = await Promise.allSettled(
        [dbA, dbB, dbA, dbB].map((db) =>
          getConnectionAccessToken(db, id, { fetchFn: vendor.fetchFn }),
        ),
      );
      expect(vendor.calls()).toBe(1);
      expect(settled.map((r) => (r.status === 'fulfilled' ? r.value : r.reason))).toEqual(
        Array(4).fill('stub-access-1'),
      );
    });

    it('recover when the first refresh fails: the other caller takes over, the lock is free', async () => {
      const id = await createConnection();
      const vendor = createVendor({ delayMs: 200, failFirst: true });
      const settled = await Promise.allSettled([
        getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }),
        getConnectionAccessToken(dbB, id, { fetchFn: vendor.fetchFn }),
      ]);
      const outcomes = settled.map((r) => (r.status === 'fulfilled' ? 'token' : r.reason));
      expect(outcomes.filter((o) => o === 'token')).toHaveLength(1);
      expect(outcomes.find((o) => o !== 'token')).toBeInstanceOf(OauthUnavailableError);
      expect(vendor.calls()).toBe(2);
      expect((await readRow(id)).status).toBe('connected');
      expect(await storedTokens(id)).toEqual({
        access: 'stub-access-1',
        refresh: 'stub-refresh-1',
      });
    });

    it('refresh again after the new expiry, with the rotated refresh token', async () => {
      const id = await createConnection();
      const vendor = createVendor({ delayMs: 50 });
      const first = await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn });
      const second = await getConnectionAccessToken(dbB, id, { fetchFn: vendor.fetchFn });
      expect([first, second, vendor.calls()]).toEqual(['stub-access-1', 'stub-access-1', 1]);

      const later = () => Date.now() + 2 * HOUR;
      const third = await getConnectionAccessToken(dbB, id, {
        fetchFn: vendor.fetchFn,
        now: later,
      });
      expect(third).toBe('stub-access-2');
      expect(vendor.calls()).toBe(2);
      expect(vendor.requests[1]?.form.refresh_token).toBe('stub-refresh-1');
      expect(await storedTokens(id)).toEqual({
        access: 'stub-access-2',
        refresh: 'stub-refresh-2',
      });
      expect((await readRow(id)).status).toBe('connected');
    });

    it('send the client and the refresh grant to the provider token url', async () => {
      const id = await createConnection();
      const vendor = createVendor();
      await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn });
      expect(vendor.requests).toEqual([
        {
          url: GITHUB_TOKEN_URL,
          form: {
            grant_type: 'refresh_token',
            refresh_token: 'stub-refresh-0',
            client_id: 'stub-client-id',
            client_secret: 'stub-client-secret',
          },
        },
      ]);
    });
  });

  describe('a refresh the provider refuses', () => {
    it('marks the connection needs_reauth on invalid_grant, with only the vendor description', async () => {
      const id = await createConnection();
      const before = await readRow(id);
      const vendor = answering(() =>
        json(400, { error: 'invalid_grant', error_description: 'The grant was revoked.' }),
      );

      const err = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }));
      expect(err).toBeInstanceOf(NeedsReauthError);
      expect(err).toMatchObject({ connectionId: id, status: 'needs_reauth' });
      const row = await readRow(id);
      expect(row.status).toBe('needs_reauth');
      expect(row.lastError).toBe('The grant was revoked.');
      expect(row.accessTokenEncrypted).toBe(before.accessTokenEncrypted);
      expect(row.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);
      expect(row.encryptedDek).toBe(before.encryptedDek);
      expect(row.expiresAt).toEqual(before.expiresAt);

      const again = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }));
      expect(again).toBeInstanceOf(NeedsReauthError);
      expect(vendor.calls()).toBe(1);
    });

    it('reads invalid_grant out of a 200, which is how GitHub answers', async () => {
      const id = await createConnection();
      const vendor = answering(() => json(200, { error: 'invalid_grant' }));
      expect(
        await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn })),
      ).toBeInstanceOf(NeedsReauthError);
      const row = await readRow(id);
      expect(row.status).toBe('needs_reauth');
      expect(row.lastError).toBe('invalid_grant');
    });

    it("reads GitHub's bad_refresh_token as needing a new connection", async () => {
      const id = await createConnection();
      const vendor = answering(() =>
        json(200, {
          error: 'bad_refresh_token',
          error_description: 'The refresh token passed is incorrect or expired.',
        }),
      );
      expect(
        await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn })),
      ).toBeInstanceOf(NeedsReauthError);
      expect((await readRow(id)).status).toBe('needs_reauth');
    });

    it('goes by the code, never by the words around it', async () => {
      const flagged = await createConnection();
      const words = answering(() =>
        json(400, { error: 'invalid_grant', error_description: 'rate limited, try again later' }),
      );
      await rejection(getConnectionAccessToken(dbA, flagged, { fetchFn: words.fetchFn }));
      expect((await readRow(flagged)).status).toBe('needs_reauth');

      const kept = await createConnection();
      const before = await readRow(kept);
      const decoy = answering(() =>
        json(400, { error: 'temporarily_unavailable', error_description: 'invalid_grant' }),
      );
      const err = await rejection(getConnectionAccessToken(dbA, kept, { fetchFn: decoy.fetchFn }));
      expect(err).toBeInstanceOf(OauthVendorError);
      expect(await readRow(kept)).toEqual(before);
    });

    it.each([
      ['invalid_client', () => json(401, { error: 'invalid_client' })],
      ['a 5xx that names invalid_grant', () => json(503, { error: 'invalid_grant' })],
      ['a 500 page', () => new Response('<html>oops</html>', { status: 500 })],
      ['a 502', () => new Response('', { status: 502 })],
    ])('leaves status and tokens as they were on %s', async (_name, respond) => {
      const id = await createConnection();
      const before = await readRow(id);
      const vendor = answering(respond);
      const err = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }));
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NeedsReauthError);
      expect(vendor.calls()).toBe(1);
      expect(await readRow(id)).toEqual(before);
    });

    it('leaves status and tokens as they were on a network failure', async () => {
      const id = await createConnection();
      const before = await readRow(id);
      const fetchFn = (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch;
      expect(await rejection(getConnectionAccessToken(dbA, id, { fetchFn }))).toBeInstanceOf(
        OauthUnavailableError,
      );
      expect(await readRow(id)).toEqual(before);
    });

    it('leaves status and tokens as they were on a timeout, and the next call can refresh', async () => {
      const id = await createConnection();
      const before = await readRow(id);
      const real = AbortSignal.timeout.bind(AbortSignal);
      const shortTimeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(30));
      const hanging = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as unknown as typeof fetch;
      const err = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: hanging }));
      expect(err).toBeInstanceOf(OauthUnavailableError);
      expect(await readRow(id)).toEqual(before);

      shortTimeout.mockRestore();
      const vendor = createVendor();
      expect(await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn })).toBe(
        'stub-access-1',
      );
    });
  });

  describe('what a successful refresh writes', () => {
    it('keeps the old refresh token when the vendor does not rotate it', async () => {
      const id = await createConnection();
      const before = await readRow(id);
      const vendor = answering(() => json(200, { access_token: 'stub-access-9', expires_in: 600 }));
      expect(await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn })).toBe(
        'stub-access-9',
      );
      expect(await storedTokens(id)).toEqual({
        access: 'stub-access-9',
        refresh: 'stub-refresh-0',
      });
      const row = await readRow(id);
      expect(row.grantedScopes).toEqual(['repo']);
      expect(row.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expect(Math.abs(row.expiresAt!.getTime() - (Date.now() + 600_000))).toBeLessThan(10_000);
    });

    it('stores the granted scopes the vendor names, comma separated or not', async () => {
      const id = await createConnection();
      const vendor = answering(() =>
        json(200, { access_token: 'stub-access-9', expires_in: 600, scope: 'repo,gist' }),
      );
      await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn });
      expect((await readRow(id)).grantedScopes).toEqual(['repo', 'gist']);
    });

    it('encrypts both tokens at rest under a new DEK each write', async () => {
      const id = await createConnection();
      const before = await readRow(id);
      const vendor = createVendor();
      await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn });
      const row = await readRow(id);
      expect(row.encryptedDek).not.toBe(before.encryptedDek);
      const stored = JSON.stringify(row);
      expect(stored).not.toContain('stub-access-');
      expect(stored).not.toContain('stub-refresh-');
      expect(row.accessTokenEncrypted).not.toBe('stub-access-1');
      expect(row.refreshTokenEncrypted).not.toBe('stub-refresh-1');
      expect(await storedTokens(id)).toEqual({
        access: 'stub-access-1',
        refresh: 'stub-refresh-1',
      });
    });

    it("refreshes with the admin's client when the environment has none, read inside the lock", async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
      vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', '');
      const envelope = envelopeEncrypt('stub-admin-secret', KEK);
      await dbA
        .insert(schema.integrationProviderConfigs)
        .values({
          providerId: 'github',
          oauthClientId: 'stub-admin-id',
          oauthClientSecretEncrypted: envelope.encryptedValue,
          encryptedDek: envelope.encryptedDek,
        })
        .onConflictDoNothing();
      const id = await createConnection();
      const vendor = createVendor();
      await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn });
      expect(vendor.requests[0]?.form).toMatchObject({
        client_id: 'stub-admin-id',
        client_secret: 'stub-admin-secret',
      });
    });

    it("refreshes a device sign-in with the owner's own client id, read inside the lock", async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
      vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', '');
      const owner = await createUser();
      const envelope = envelopeEncrypt('stub-user-id', KEK);
      await dbA.insert(schema.userSecrets).values({
        userId: owner,
        keyName: 'github_client_id',
        encryptedValue: envelope.encryptedValue,
        encryptedDek: envelope.encryptedDek,
      });
      const id = await createConnection({ ownerUserId: owner, authMethod: 'device' });
      const vendor = createVendor();
      await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn });
      expect(vendor.requests[0]?.form).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'stub-refresh-0',
        client_id: 'stub-user-id',
      });
    });

    it('sends no client secret for a device sign-in whose client has none', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', '');
      const id = await createConnection({ authMethod: 'device' });
      const vendor = createVendor();
      await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn });
      expect(vendor.requests[0]?.form).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'stub-refresh-0',
        client_id: 'stub-client-id',
      });
    });
  });

  describe('the client that issued a connection', () => {
    async function setUserClient(owner: string, clientId: string) {
      const envelope = envelopeEncrypt(clientId, KEK);
      await dbA.insert(schema.userSecrets).values({
        userId: owner,
        keyName: 'github_client_id',
        encryptedValue: envelope.encryptedValue,
        encryptedDek: envelope.encryptedDek,
      });
    }

    async function setAdminClient(clientId: string, secret: string) {
      const envelope = envelopeEncrypt(secret, KEK);
      await dbA.insert(schema.integrationProviderConfigs).values({
        providerId: 'github',
        oauthClientId: clientId,
        oauthClientSecretEncrypted: envelope.encryptedValue,
        encryptedDek: envelope.encryptedDek,
      });
    }

    it("keeps refreshing with the owner's own client after the environment gains one", async () => {
      const owner = await createUser();
      await setUserClient(owner, 'stub-user-id');
      const id = await createConnection({
        ownerUserId: owner,
        authMethod: 'device',
        oauthClientId: 'stub-user-id',
      });
      const vendor = createVendor();
      await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn });
      expect(vendor.requests[0]?.form).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'stub-refresh-0',
        client_id: 'stub-user-id',
      });
    });

    it('needs a new connection, with no vendor call, once the admin row names another client', async () => {
      await setAdminClient('stub-admin-id-2', 'stub-admin-secret');
      const id = await createConnection({ oauthClientId: 'stub-admin-id' });
      const before = await readRow(id);
      const vendor = createVendor();

      const err = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }));
      expect(vendor.calls()).toBe(0);
      expect(err).toBeInstanceOf(NeedsReauthError);
      const row = await readRow(id);
      expect(row.status).toBe('needs_reauth');
      expect(row.lastError).toBe('The OAuth client that issued this connection was replaced.');
      expect(row.accessTokenEncrypted).toBe(before.accessTokenEncrypted);
      expect(row.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);
    });

    it('keeps the connection, writing nothing, while no client is configured at all', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
      const id = await createConnection({ oauthClientId: 'stub-admin-id' });
      const before = await readRow(id);
      const vendor = createVendor();
      const err = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }));
      expect(err).toBeInstanceOf(OauthUnavailableError);
      expect(vendor.calls()).toBe(0);
      expect(await readRow(id)).toEqual(before);
    });

    it('refreshes a connection that recorded no client with the highest-priority one', async () => {
      const owner = await createUser();
      await setUserClient(owner, 'stub-user-id');
      await setAdminClient('stub-admin-id', 'stub-admin-secret');
      const id = await createConnection({ ownerUserId: owner, authMethod: 'device' });
      const vendor = createVendor();
      await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn });
      expect(vendor.requests[0]?.form).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'stub-refresh-0',
        client_id: 'stub-client-id',
        client_secret: 'stub-client-secret',
      });
    });
  });

  describe('a connection that is not refreshed', () => {
    it.each(['needs_reauth', 'revoked', 'provider_unavailable'] as const)(
      'throws NeedsReauthError for status %s without any vendor call',
      async (status) => {
        const id = await createConnection({ status });
        const vendor = createVendor();
        const err = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }));
        expect(err).toBeInstanceOf(NeedsReauthError);
        expect(err).toMatchObject({ connectionId: id, status });
        expect(vendor.calls()).toBe(0);
      },
    );

    it('hands back the Git credential secret of a credential-backed connection, never refreshing', async () => {
      const owner = await createUser();
      const envelope = envelopeEncrypt('stub-git-secret', KEK);
      const [credential] = await dbA
        .insert(schema.repoCredentials)
        .values({
          userId: owner,
          label: 'GitHub OAuth (octocat)',
          host: 'github.com',
          usernameEncrypted: envelopeEncrypt('octocat', KEK).encryptedValue,
          secretEncrypted: envelope.encryptedValue,
          encryptedDek: envelope.encryptedDek,
        })
        .returning({ id: schema.repoCredentials.id });
      const id = await createConnection({
        ownerUserId: owner,
        repoCredentialId: credential!.id,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        encryptedDek: null,
        expiresAt: new Date(Date.now() - HOUR),
      });
      const vendor = createVendor();
      expect(await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn })).toBe(
        'stub-git-secret',
      );
      expect(vendor.calls()).toBe(0);
    });

    it('decrypts and returns a token that is not about to expire, without a vendor call', async () => {
      const vendor = createVendor();
      const fresh = await createConnection({ expiresAt: new Date(Date.now() + 10 * 60_000) });
      expect(await getConnectionAccessToken(dbA, fresh, { fetchFn: vendor.fetchFn })).toBe(
        'stub-access-0',
      );
      const forever = await createConnection({ expiresAt: null });
      expect(await getConnectionAccessToken(dbA, forever, { fetchFn: vendor.fetchFn })).toBe(
        'stub-access-0',
      );
      expect(vendor.calls()).toBe(0);
    });

    it('refreshes a token that expires inside the five minute margin', async () => {
      const id = await createConnection({ expiresAt: new Date(Date.now() + 2 * 60_000) });
      const vendor = createVendor();
      expect(await getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn })).toBe(
        'stub-access-1',
      );
      expect(vendor.calls()).toBe(1);
    });

    it('marks a connection needs_reauth when it expires and holds no refresh token', async () => {
      const id = await createConnection({ refreshToken: null });
      const vendor = createVendor();
      const err = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }));
      expect(err).toBeInstanceOf(NeedsReauthError);
      expect(vendor.calls()).toBe(0);
      expect((await readRow(id)).status).toBe('needs_reauth');
    });

    it('fails without writing when no OAuth client is configured for the provider', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
      const id = await createConnection();
      const before = await readRow(id);
      const vendor = createVendor();
      const err = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }));
      expect(err).toBeInstanceOf(OauthUnavailableError);
      expect(vendor.calls()).toBe(0);
      expect(await readRow(id)).toEqual(before);
    });

    it('fails without writing when the provider has no refreshable method', async () => {
      const id = await createConnection({ providerId: 'gitlab', authMethod: 'token' });
      const before = await readRow(id);
      const vendor = createVendor();
      const err = await rejection(getConnectionAccessToken(dbA, id, { fetchFn: vendor.fetchFn }));
      expect(err).toBeInstanceOf(OauthUnavailableError);
      expect(vendor.calls()).toBe(0);
      expect(await readRow(id)).toEqual(before);
    });

    it('throws ConnectionNotFoundError for an id that is not a connection', async () => {
      const vendor = createVendor();
      const err = await rejection(
        getConnectionAccessToken(dbA, '00000000-0000-4000-8000-000000000001', {
          fetchFn: vendor.fetchFn,
        }),
      );
      expect(err).toBeInstanceOf(ConnectionNotFoundError);
    });
  });
});
