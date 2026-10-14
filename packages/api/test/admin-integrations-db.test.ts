import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.ADMIN_INTEGRATIONS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/admin_integrations_test'))
  throw new Error(
    'Use a dedicated admin_integrations_test database for the admin integrations tests',
  );

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null },
}));

import { Hono } from 'hono';
import { envelopeDecrypt, secretsService } from '@haive/shared';
import {
  isProviderEnabled,
  listIntegrationProviders,
  resolveOauthClient,
} from '@haive/shared/integrations';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const KEK = 'ab'.repeat(32);
const WEB_ORIGIN = 'https://haive.example.test';
const AUDIT_ACTION = 'integration.provider_config.update';
const CLIENT_ID = 'stub-admin-client-id';
const SECRET = 'stub-admin-client-secret-must-not-leak';
const NEXT_SECRET = 'stub-admin-client-secret-replacement';
const ENV_CLIENT_ID = 'stub-env-client-id';

interface ProviderJson {
  id: string;
  name: string;
  categories: string[];
  authKinds: string[];
  enabled: boolean;
  rowExists: boolean;
  oauthClientId: string | null;
  hasClientSecret: boolean;
  redirectUri: string;
  precedence: { envVar: string; envSet: boolean } | null;
}

describe.skipIf(!url)('admin integrations routes on Postgres', () => {
  let db: Database;
  let adminId: string;
  let userId: string;
  const createdUsers: string[] = [];
  const bodies: string[] = [];

  async function createUser(role: 'admin' | 'user'): Promise<string> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'admin-integrations-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role,
      })
      .returning({ id: schema.users.id });
    createdUsers.push(user!.id);
    return user!.id;
  }

  const sessionOf = async (id: string, role: 'admin' | 'user') =>
    `${ACCESS_COOKIE}=${await signAccessToken({ sub: id, role, tv: 0 })}`;

  const app = createApiApp('http://localhost:3000');

  async function send(
    client: Pick<Hono<AppEnv>, 'request'>,
    cookie: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const res = await client.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    bodies.push(await res.clone().text());
    return res;
  }

  const asAdmin = async (method: string, path: string, body?: unknown) =>
    send(app, await sessionOf(adminId, 'admin'), method, path, body);
  const put = (providerId: string, body: unknown) =>
    asAdmin('PUT', `/admin/integrations/providers/${providerId}`, body);
  const list = async () =>
    (
      (await (await asAdmin('GET', '/admin/integrations/providers')).json()) as {
        providers: ProviderJson[];
      }
    ).providers;
  const provider = async (providerId: string) => (await list()).find((p) => p.id === providerId)!;
  const savedProvider = async (res: Response) =>
    ((await res.json()) as { provider: ProviderJson }).provider;

  const configRows = () => db.select().from(schema.integrationProviderConfigs);
  const configRow = async (providerId: string) =>
    (
      await db
        .select()
        .from(schema.integrationProviderConfigs)
        .where(eq(schema.integrationProviderConfigs.providerId, providerId))
    )[0];
  const auditRows = () =>
    db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, AUDIT_ACTION))
      .orderBy(schema.auditEvents.createdAt);

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    adminId = await createUser('admin');
    userId = await createUser('user');
  });

  beforeEach(async () => {
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    vi.stubEnv('WEB_ORIGIN', WEB_ORIGIN);
    vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
    vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', '');
    bodies.length = 0;
    await db.delete(schema.integrationProviderConfigs);
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.action, AUDIT_ACTION));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await db.delete(schema.integrationProviderConfigs);
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.action, AUDIT_ACTION));
    await db.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await db.$client.end({ timeout: 5 });
  });

  describe('who may call it', () => {
    it('refuses a non-admin and a caller with no session on GET and PUT, writes nothing, and lets an admin in', async () => {
      const get = '/admin/integrations/providers';
      const write = '/admin/integrations/providers/github';
      const body = { enabled: false, oauthClientId: CLIENT_ID, oauthClientSecret: SECRET };
      const user = await sessionOf(userId, 'user');

      expect((await send(app, user, 'GET', get)).status).toBe(403);
      expect((await send(app, user, 'PUT', write, body)).status).toBe(403);
      expect((await send(app, null, 'GET', get)).status).toBe(401);
      expect((await send(app, null, 'PUT', write, body)).status).toBe(401);
      expect(await configRows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
      expect((await asAdmin('GET', get)).status).toBe(200);
    });

    it('guards its own router, not only through the guard the app puts on /admin', async () => {
      const { adminIntegrationRoutes } = await import('../src/routes/admin-integrations.js');
      const bare = new Hono<AppEnv>();
      bare.route('/admin/integrations', adminIntegrationRoutes);
      bare.onError(errorHandler);
      const user = await sessionOf(userId, 'user');
      const admin = await sessionOf(adminId, 'admin');
      const get = '/admin/integrations/providers';
      const write = '/admin/integrations/providers/github';

      expect((await send(bare, null, 'GET', get)).status).toBe(401);
      expect((await send(bare, user, 'GET', get)).status).toBe(403);
      expect((await send(bare, user, 'PUT', write, { enabled: false })).status).toBe(403);
      expect(await configRows()).toEqual([]);
      expect((await send(bare, admin, 'GET', get)).status).toBe(200);
    });
  });

  describe('GET /admin/integrations/providers', () => {
    it('lists every registered provider with its sign-in kinds, default enablement and redirect URI', async () => {
      const providers = await list();
      expect(providers.map((p) => p.id)).toEqual(listIntegrationProviders().map((p) => p.id));
      for (const p of providers) {
        expect(p).toMatchObject({
          enabled: true,
          rowExists: false,
          oauthClientId: null,
          hasClientSecret: false,
          redirectUri: `${WEB_ORIGIN}/settings/integrations/callback/${p.id}`,
        });
      }
      expect(providers.find((p) => p.id === 'github')).toMatchObject({
        name: 'GitHub',
        categories: ['forge'],
        authKinds: ['token', 'device', 'oauth2'],
      });
      expect(providers.find((p) => p.id === 'gitlab')?.authKinds).toEqual(['token']);
    });

    it('names the environment variable that outranks the saved client, for GitHub only', async () => {
      const providers = await list();
      expect(providers.find((p) => p.id === 'github')?.precedence).toEqual({
        envVar: 'GITHUB_OAUTH_CLIENT_ID',
        envSet: false,
      });
      expect(providers.filter((p) => p.id !== 'github').map((p) => p.precedence)).toEqual(
        providers.filter((p) => p.id !== 'github').map(() => null),
      );

      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', ENV_CLIENT_ID);
      expect((await provider('github')).precedence?.envSet).toBe(true);
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '   ');
      expect((await provider('github')).precedence?.envSet).toBe(false);
    });
  });

  describe('PUT /admin/integrations/providers/:id', () => {
    it('round-trips the client id and the secret flag, and no response or audit row holds the secret', async () => {
      const res = await put('github', { oauthClientId: CLIENT_ID, oauthClientSecret: SECRET });
      expect(res.status).toBe(200);
      expect(await savedProvider(res)).toMatchObject({
        id: 'github',
        oauthClientId: CLIENT_ID,
        hasClientSecret: true,
        rowExists: true,
      });
      expect(await provider('github')).toMatchObject({
        oauthClientId: CLIENT_ID,
        hasClientSecret: true,
        rowExists: true,
      });

      const audits = await auditRows();
      expect(audits).toHaveLength(1);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify([bodies, audits])).not.toContain(SECRET);
    });

    it('stores the secret as ciphertext under its own key and decrypts it with the master key', async () => {
      await put('github', { oauthClientId: CLIENT_ID, oauthClientSecret: SECRET });
      const stored = await configRow('github');
      expect(stored?.oauthClientSecretEncrypted).toBeTypeOf('string');
      expect(stored?.oauthClientSecretEncrypted).not.toBe(SECRET);
      expect(JSON.stringify(stored)).not.toContain(SECRET);
      expect(
        envelopeDecrypt(
          {
            encryptedValue: stored!.oauthClientSecretEncrypted!,
            encryptedDek: stored!.encryptedDek!,
          },
          KEK,
        ),
      ).toBe(SECRET);

      await put('github', { oauthClientSecret: NEXT_SECRET });
      const replaced = await configRow('github');
      expect(replaced?.oauthClientSecretEncrypted).not.toBe(stored?.oauthClientSecretEncrypted);
      expect(
        envelopeDecrypt(
          {
            encryptedValue: replaced!.oauthClientSecretEncrypted!,
            encryptedDek: replaced!.encryptedDek!,
          },
          KEK,
        ),
      ).toBe(NEXT_SECRET);
      expect(replaced?.oauthClientId).toBe(CLIENT_ID);
    });

    it('clears the secret on an empty string and keeps the client id', async () => {
      await put('github', { oauthClientId: CLIENT_ID, oauthClientSecret: SECRET });
      const res = await put('github', { oauthClientSecret: '' });
      expect(res.status).toBe(200);
      expect(await savedProvider(res)).toMatchObject({
        oauthClientId: CLIENT_ID,
        hasClientSecret: false,
      });
      expect(await configRow('github')).toMatchObject({
        oauthClientId: CLIENT_ID,
        oauthClientSecretEncrypted: null,
        encryptedDek: null,
      });
      expect(JSON.stringify(bodies)).not.toContain(SECRET);
    });

    it('clears the client id on an empty string', async () => {
      await put('github', { oauthClientId: CLIENT_ID });
      const res = await put('github', { oauthClientId: '' });
      expect(await savedProvider(res)).toMatchObject({ oauthClientId: null });
      expect((await configRow('github'))?.oauthClientId).toBeNull();
    });

    it('keeps a core provider enabled when its first save sets only a client id', async () => {
      const res = await put('gitlab', { oauthClientId: CLIENT_ID });
      expect(res.status).toBe(200);
      expect(await savedProvider(res)).toMatchObject({ enabled: true, rowExists: true });
      expect((await configRow('gitlab'))?.enabled).toBe(true);
      expect(await isProviderEnabled(db, 'gitlab')).toBe(true);
    });

    it('lets the switch turn a provider off and on, and leaves it where it is on a save that does not set it', async () => {
      expect(await savedProvider(await put('gitlab', { enabled: false }))).toMatchObject({
        enabled: false,
        rowExists: true,
      });
      expect(await isProviderEnabled(db, 'gitlab')).toBe(false);

      expect(await savedProvider(await put('gitlab', { oauthClientId: CLIENT_ID }))).toMatchObject({
        enabled: false,
      });
      expect(await isProviderEnabled(db, 'gitlab')).toBe(false);
      expect((await provider('gitlab')).enabled).toBe(false);

      expect(await savedProvider(await put('gitlab', { enabled: true }))).toMatchObject({
        enabled: true,
      });
      expect(await isProviderEnabled(db, 'gitlab')).toBe(true);
    });

    it('answers 404 for a provider that is not registered and writes nothing', async () => {
      const body = { enabled: true, oauthClientId: CLIENT_ID, oauthClientSecret: SECRET };
      for (const providerId of ['dropbox', 'module.drive-x.google-docs', 'Not%20A%20Provider']) {
        expect((await put(providerId, body)).status, providerId).toBe(404);
      }
      expect(await configRows()).toEqual([]);
      expect(await auditRows()).toEqual([]);

      expect((await put('github', body)).status).toBe(200);
      expect((await configRows()).map((r) => r.providerId)).toEqual(['github']);
    });

    it.each([
      ['an empty body', {}],
      ['a switch that is not a boolean', { enabled: 'yes' }],
      ['a client id over 256 characters', { oauthClientId: 'x'.repeat(257) }],
      ['a secret over 4096 characters', { oauthClientSecret: 'x'.repeat(4097) }],
    ])('answers 400 for %s and writes nothing', async (_name, body) => {
      const res = await put('github', body);
      expect(res.status).toBe(400);
      expect(await configRows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it('audits each save with the provider and which fields changed, never a value', async () => {
      await put('github', { enabled: false });
      await put('github', { oauthClientId: CLIENT_ID, oauthClientSecret: SECRET });
      await put('github', { oauthClientSecret: '' });

      const events = await auditRows();
      expect(events.map((e) => e.metadata)).toEqual([
        {
          providerId: 'github',
          enabledChanged: true,
          oauthClientIdChanged: false,
          oauthClientSecretChanged: false,
        },
        {
          providerId: 'github',
          enabledChanged: false,
          oauthClientIdChanged: true,
          oauthClientSecretChanged: true,
        },
        {
          providerId: 'github',
          enabledChanged: false,
          oauthClientIdChanged: false,
          oauthClientSecretChanged: true,
        },
      ]);
      for (const event of events) {
        expect(event).toMatchObject({
          actorUserId: adminId,
          action: AUDIT_ACTION,
          targetType: 'integration_provider_config',
          targetId: null,
        });
      }
      expect(JSON.stringify(events)).not.toContain(CLIENT_ID);
    });
  });

  describe('what the saved client does to the OAuth broker', () => {
    it('is the client resolveOauthClient returns for a user with no env and no id of their own', async () => {
      await put('github', { oauthClientId: CLIENT_ID, oauthClientSecret: SECRET });
      const admin = { clientId: CLIENT_ID, clientSecret: SECRET, source: 'admin' };

      expect(await resolveOauthClient(db, 'github', userId, 'device')).toEqual(admin);
      expect(await resolveOauthClient(db, 'github', userId, 'oauth2')).toEqual(admin);

      await put('github', { oauthClientSecret: '' });
      expect(await resolveOauthClient(db, 'github', userId, 'device')).toEqual({
        clientId: CLIENT_ID,
        clientSecret: null,
        source: 'admin',
      });
      expect(await resolveOauthClient(db, 'github', userId, 'oauth2')).toBeNull();
    });

    it('loses to the GitHub environment variable, which the listing says wins', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', ENV_CLIENT_ID);
      await put('github', { oauthClientId: CLIENT_ID, oauthClientSecret: SECRET });

      expect(await resolveOauthClient(db, 'github', userId, 'device')).toMatchObject({
        clientId: ENV_CLIENT_ID,
        source: 'env',
      });
      expect((await provider('github')).precedence).toEqual({
        envVar: 'GITHUB_OAUTH_CLIENT_ID',
        envSet: true,
      });
    });
  });
});
