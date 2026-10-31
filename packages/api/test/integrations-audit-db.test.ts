import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.INTEGRATIONS_AUDIT_TEST_URL;
const redisUrl = process.env.INTEGRATIONS_AUDIT_TEST_REDIS_URL;
if (url && !new URL(url).pathname.startsWith('/integrations_audit_test'))
  throw new Error(
    'Use a dedicated integrations_audit_test database for the integration audit tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'fatal';
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
        scopes: { read: ['files.read'], write: ['files.write'] },
        pkce: true,
        clientRegistration: ['preregistered'],
        userInfo,
      },
    ],
    operations: [
      { opId: 'read_file', description: 'Read a file', inputSchema: {}, access: 'read' },
    ],
  };
  return { db: undefined as unknown, stub };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getFresh: async () => null,
    getBoolean: async () => true,
  },
}));

import { secretsService, userSecretsService } from '@haive/shared';
import type { ResolvedOauthClient } from '@haive/shared/integrations';
import type { IntegrationProviderSpec } from '@haive/shared/modularity';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';
import { finishSignIn } from '../src/lib/integration-sign-in.js';
import { putOauthAttempt } from '../src/lib/integration-state.js';
import { closeRedis, getRedis, initRedis } from '../src/redis.js';

const KEK = 'ab'.repeat(32);
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const ENV_CLIENT = { id: 'env-client-id', secret: 'env-client-secret' };

const refuseAuditInserts = async (db: Database) => {
  await db.execute(
    sql.raw(
      "CREATE OR REPLACE FUNCTION refuse_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit insert refused'; END $$;",
    ),
  );
  await db.execute(
    sql.raw(
      'CREATE TRIGGER refuse_audit_insert BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_audit_insert();',
    ),
  );
};
const allowAuditInserts = async (db: Database) => {
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS refuse_audit_insert ON audit_events;'));
  await db.execute(sql.raw('DROP FUNCTION IF EXISTS refuse_audit_insert();'));
};
const refuseClientSecretWrites = async (db: Database) => {
  await db.execute(
    sql.raw(
      "CREATE OR REPLACE FUNCTION refuse_client_secret_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key_name = 'github_client_id' THEN RAISE EXCEPTION 'secret write refused'; END IF; RETURN NEW; END $$;",
    ),
  );
  await db.execute(
    sql.raw(
      'CREATE TRIGGER refuse_client_secret_write BEFORE INSERT OR UPDATE ON user_secrets FOR EACH ROW EXECUTE FUNCTION refuse_client_secret_write();',
    ),
  );
};
const allowClientSecretWrites = async (db: Database) => {
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS refuse_client_secret_write ON user_secrets;'));
  await db.execute(sql.raw('DROP FUNCTION IF EXISTS refuse_client_secret_write();'));
};

describe.skipIf(!url || !redisUrl)(
  'integration actions write their audit row in the same transaction, on Postgres',
  () => {
    let db: Database;
    let app: ReturnType<typeof createApiApp>;
    let adminId: string;
    let userId: string;
    let adminCookie: string;
    let userCookie: string;
    let token: string;

    const send = (as: 'admin' | 'user', method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          'content-type': 'application/json',
          cookie: as === 'admin' ? adminCookie : userCookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const makeUser = async (role: 'admin' | 'user') => {
      const [row] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: `${randomUUID()}@integrations-audit.test.local`,
          emailBlindIndex: randomBytes(16).toString('hex'),
          passwordHash: 'not-a-real-hash',
          role,
        })
        .returning({ id: schema.users.id });
      return row!.id;
    };

    const auditFor = (actor: string, action?: string) =>
      db
        .select()
        .from(schema.auditEvents)
        .where(
          action === undefined
            ? eq(schema.auditEvents.actorUserId, actor)
            : and(eq(schema.auditEvents.actorUserId, actor), eq(schema.auditEvents.action, action)),
        );

    const providerRows = () =>
      db
        .select()
        .from(schema.integrationProviderConfigs)
        .where(eq(schema.integrationProviderConfigs.providerId, 'github'));
    const defaultRows = () =>
      db
        .select()
        .from(schema.integrationCategoryPreferences)
        .where(eq(schema.integrationCategoryPreferences.categoryId, 'forge'));
    const connectionRows = () =>
      db
        .select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.ownerUserId, userId));
    const credentialRows = () =>
      db.select().from(schema.repoCredentials).where(eq(schema.repoCredentials.userId, userId));
    const settingRows = () =>
      db
        .select()
        .from(schema.integrationUserSettings)
        .where(eq(schema.integrationUserSettings.userId, userId));
    const secretRows = () =>
      db.select().from(schema.userSecrets).where(eq(schema.userSecrets.userId, userId));

    const seedProvider = () =>
      db.insert(schema.integrationProviderConfigs).values({
        providerId: 'github',
        enabled: true,
        oauthClientId: 'old-client',
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      });
    const seedDefault = () =>
      db
        .insert(schema.integrationCategoryPreferences)
        .values({ userId: null, categoryId: 'forge', providerId: 'github', connectionId: null });
    const seedCredential = async () => {
      const [row] = await db
        .insert(schema.repoCredentials)
        .values({
          userId,
          label: 'my github',
          host: 'github.com',
          usernameEncrypted: 'x',
          secretEncrypted: 'x',
          encryptedDek: 'x',
        })
        .returning();
      return row!;
    };
    const seedConnection = async (repoCredentialId: string) => {
      const [row] = await db
        .insert(schema.integrationConnections)
        .values({
          providerId: 'github',
          scope: 'user',
          ownerUserId: userId,
          accountLabel: 'my github',
          authMethod: 'token',
          repoCredentialId,
        })
        .returning();
      return row!;
    };

    const attempt = async () => {
      const state = randomBytes(16).toString('hex');
      await putOauthAttempt(getRedis(), userId, 'github', state, {
        verifier: 'verifier',
        redirectUri: 'http://localhost:3000/integrations/callback',
        scopes: ['repo'],
        clientId: ENV_CLIENT.id,
      });
      return state;
    };
    const completeSignIn = async () =>
      send('user', 'POST', '/integrations/oauth/complete', {
        providerId: 'github',
        state: await attempt(),
        code: 'the-code',
      });

    beforeAll(async () => {
      db = createDatabase(url as string);
      h.db = db;
      initRedis(redisUrl as string);
      await userSecretsService.initialize(db, KEK);
      app = createApiApp('http://localhost:3000');
    });

    afterAll(async () => {
      await closeRedis();
      await db.$client.end({ timeout: 5 });
    });

    beforeEach(async () => {
      vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
      vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', ENV_CLIENT.id);
      vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', ENV_CLIENT.secret);
      token = 'tok-A';
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const target = String(input instanceof Request ? input.url : input);
          const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
          if (target === GITHUB_TOKEN_URL) {
            return json({ access_token: token, token_type: 'bearer', scope: 'repo' });
          }
          if (target === GITHUB_USER_URL) return json({ id: 4242, login: 'octo' });
          if (target === h.stub.auth[0]!.userInfo.url)
            return json({ id: 'acct-1', email: 'a@b.c' });
          return new Response('not stubbed', { status: 404 });
        }),
      );
      adminId = await makeUser('admin');
      userId = await makeUser('user');
      adminCookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: adminId, role: 'admin', tv: 0 })}`;
      userCookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await allowAuditInserts(db);
      await allowClientSecretWrites(db);
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, adminId));
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, userId));
      await db.delete(schema.integrationCategoryPreferences);
      await db.delete(schema.integrationConnections);
      await db.delete(schema.integrationUserSettings);
      await db.delete(schema.integrationProviderConfigs);
      await db.delete(schema.userSecrets);
      await db.delete(schema.repoCredentials);
      await db.delete(schema.users).where(eq(schema.users.id, adminId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      const keys = await getRedis().keys(`integration-*:${userId}:*`);
      if (keys.length > 0) await getRedis().del(...keys);
    });

    describe('PUT /admin/integrations/providers/:id', () => {
      const put = (body: unknown) =>
        send('admin', 'PUT', '/admin/integrations/providers/github', body);
      const full = {
        enabled: false,
        oauthClientId: 'new-client',
        oauthClientSecret: 'new-secret',
      };

      it('A1 refused: answers 500 and leaves the saved row unchanged', async () => {
        await seedProvider();
        const before = await providerRows();
        await refuseAuditInserts(db);
        expect((await put(full)).status).toBe(500);
        expect(await providerRows()).toEqual(before);
        await allowAuditInserts(db);
        expect(await auditFor(adminId)).toEqual([]);
      });

      it('A2 refused: answers 500 and creates no row', async () => {
        await refuseAuditInserts(db);
        expect((await put({ oauthClientId: 'x' })).status).toBe(500);
        expect(await providerRows()).toEqual([]);
      });

      it('A3 saves the row and writes one audit row without the secret', async () => {
        await seedProvider();
        expect((await put(full)).status).toBe(200);
        const [saved] = await providerRows();
        expect(saved).toMatchObject({ enabled: false, oauthClientId: 'new-client' });
        expect(saved!.oauthClientSecretEncrypted).not.toBeNull();
        const rows = await auditFor(adminId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'integration.provider_config.update',
          targetType: 'integration_provider_config',
          metadata: {
            providerId: 'github',
            enabledChanged: true,
            oauthClientIdChanged: true,
            oauthClientSecretChanged: true,
          },
        });
        expect(rows[0]!.metadata).toEqual({
          providerId: 'github',
          enabledChanged: true,
          oauthClientIdChanged: true,
          oauthClientSecretChanged: true,
        });
        expect(JSON.stringify(rows)).not.toContain('new-secret');
      });
    });

    describe('PUT /admin/integrations/defaults/:categoryId', () => {
      const put = (body: unknown) =>
        send('admin', 'PUT', '/admin/integrations/defaults/forge', body);

      it('B1 refused: answers 500 and keeps the default', async () => {
        await seedDefault();
        const before = await defaultRows();
        await refuseAuditInserts(db);
        expect((await put({ providerId: 'gitea' })).status).toBe(500);
        expect(await defaultRows()).toEqual(before);
      });

      it('B2 refused removal: answers 500 and keeps the default', async () => {
        await seedDefault();
        const before = await defaultRows();
        expect(before).toHaveLength(1);
        await refuseAuditInserts(db);
        expect((await put({ providerId: null })).status).toBe(500);
        expect(await defaultRows()).toEqual(before);
      });

      it('B3 sets the default and writes one audit row', async () => {
        expect((await put({ providerId: 'gitea' })).status).toBe(200);
        expect(await defaultRows()).toMatchObject([{ userId: null, providerId: 'gitea' }]);
        const rows = await auditFor(adminId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'integration.category_default.update',
          targetType: 'integration_category_default',
        });
        expect(rows[0]!.metadata).toEqual({ categoryId: 'forge', providerId: 'gitea' });
      });

      it('B4 removes the default and writes one audit row', async () => {
        await seedDefault();
        expect((await put({ providerId: null })).status).toBe(200);
        expect(await defaultRows()).toEqual([]);
        const rows = await auditFor(adminId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: 'integration.category_default.update' });
        expect(rows[0]!.metadata).toEqual({ categoryId: 'forge', providerId: null });
      });
    });

    describe('PUT /integrations/github', () => {
      const put = (body: unknown) => send('user', 'PUT', '/integrations/github', body);
      const seed = () => userSecretsService.set(userId, 'github_client_id', 'old-client-id', 'x');

      it('C1 refused: answers 500 and keeps the old client id', async () => {
        await seed();
        await refuseAuditInserts(db);
        expect((await put({ clientId: 'new-client-id' })).status).toBe(500);
        expect(await userSecretsService.get(userId, 'github_client_id')).toBe('old-client-id');
      });

      it('C2 refused removal: answers 500 and keeps the old client id', async () => {
        await seed();
        await refuseAuditInserts(db);
        expect((await put({ clientId: '' })).status).toBe(500);
        expect(await userSecretsService.get(userId, 'github_client_id')).toBe('old-client-id');
      });

      it('C3 refused first set: answers 500 and stores nothing', async () => {
        await refuseAuditInserts(db);
        expect((await put({ clientId: 'new-client-id' })).status).toBe(500);
        expect(await userSecretsService.get(userId, 'github_client_id')).toBeNull();
        expect(await secretRows()).toEqual([]);
      });

      it('C4 stores the client id and writes one audit row without it', async () => {
        await seed();
        expect((await put({ clientId: 'new-client-id' })).status).toBe(200);
        expect(await userSecretsService.get(userId, 'github_client_id')).toBe('new-client-id');
        const rows = await auditFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'integration.github_client.update',
          targetType: 'integration_provider',
        });
        expect(rows[0]!.metadata).toEqual({ clientIdSet: true });
        expect(JSON.stringify(rows)).not.toContain('new-client-id');
      });

      it('C5 removes the client id and writes one audit row', async () => {
        await seed();
        expect((await put({ clientId: '' })).status).toBe(200);
        expect(await userSecretsService.get(userId, 'github_client_id')).toBeNull();
        const rows = await auditFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.metadata).toEqual({ clientIdSet: false });
      });

      it('C6 a refused secret write answers 500 and writes no audit row', async () => {
        await seed();
        await refuseClientSecretWrites(db);
        expect((await put({ clientId: 'new-client-id' })).status).toBe(500);
        await allowClientSecretWrites(db);
        expect(await userSecretsService.get(userId, 'github_client_id')).toBe('old-client-id');
        expect(await auditFor(userId)).toEqual([]);
      });
    });

    describe('POST /integrations/providers/:id/link-credential', () => {
      const link = (repoCredentialId: string) =>
        send('user', 'POST', '/integrations/providers/github/link-credential', {
          repoCredentialId,
        });

      it('D1 refused: answers 500 and creates no connection', async () => {
        const credential = await seedCredential();
        await refuseAuditInserts(db);
        expect((await link(credential.id)).status).toBe(500);
        expect(await connectionRows()).toEqual([]);
      });

      it('D2 links the credential and writes one audit row', async () => {
        const credential = await seedCredential();
        expect((await link(credential.id)).status).toBe(201);
        const [connection] = await connectionRows();
        expect(connection).toMatchObject({ repoCredentialId: credential.id });
        const rows = await auditFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'integration.connection.create',
          targetType: 'integration_connection',
          targetId: connection!.id,
        });
        expect(rows[0]!.metadata).toEqual({
          providerId: 'github',
          authMethod: 'token',
          credentialBacked: true,
          repoCredentialId: credential.id,
        });
      });

      it('D3 a repeat is a 409 and adds neither a connection nor an audit row', async () => {
        const credential = await seedCredential();
        expect((await link(credential.id)).status).toBe(201);
        expect((await link(credential.id)).status).toBe(409);
        expect(await connectionRows()).toHaveLength(1);
        expect(await auditFor(userId)).toHaveLength(1);
      });
    });

    describe('PUT /integrations/providers/:id/write', () => {
      const put = (writeEnabled: boolean) =>
        send('user', 'PUT', '/integrations/providers/github/write', { writeEnabled });

      it('E1 refused: answers 500 and creates no settings row', async () => {
        await refuseAuditInserts(db);
        expect((await put(true)).status).toBe(500);
        expect(await settingRows()).toEqual([]);
      });

      it('E2 refused: answers 500 and leaves the settings row unchanged', async () => {
        await db.insert(schema.integrationUserSettings).values({
          userId,
          providerId: 'github',
          writeEnabled: true,
          updatedAt: new Date('2020-01-01T00:00:00Z'),
        });
        const before = await settingRows();
        await refuseAuditInserts(db);
        expect((await put(false)).status).toBe(500);
        expect(await settingRows()).toEqual(before);
      });

      it('E3 sets the switch and writes one audit row', async () => {
        expect((await put(true)).status).toBe(200);
        expect(await settingRows()).toMatchObject([{ providerId: 'github', writeEnabled: true }]);
        const rows = await auditFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'integration.write_switch',
          targetType: 'integration_provider',
        });
        expect(rows[0]!.metadata).toEqual({ providerId: 'github', writeEnabled: true });
      });
    });

    describe('sign-in (finishSignIn)', () => {
      it('F1 refused: answers 500 and writes no connection, credential or audit row', async () => {
        await refuseAuditInserts(db);
        expect((await completeSignIn()).status).toBe(500);
        expect(await connectionRows()).toEqual([]);
        expect(await credentialRows()).toEqual([]);
        await allowAuditInserts(db);
        expect(await auditFor(userId)).toEqual([]);
      });

      it('F2 connects the account and writes one audit row without a token or secret', async () => {
        expect((await completeSignIn()).status).toBe(200);
        const [connection] = await connectionRows();
        const [credential] = await credentialRows();
        expect(connection).toMatchObject({
          externalAccountId: '4242',
          repoCredentialId: credential!.id,
        });
        expect(credential).toMatchObject({ host: 'github.com' });
        const rows = await auditFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'integration.connection.create',
          targetType: 'integration_connection',
          targetId: connection!.id,
        });
        expect(rows[0]!.metadata).toEqual({
          providerId: 'github',
          authMethod: 'oauth2',
          clientSource: 'env',
          credentialBacked: true,
          repoCredentialId: credential!.id,
        });
        expect(JSON.stringify(rows)).not.toContain('tok-A');
        expect(JSON.stringify(rows)).not.toContain(ENV_CLIENT.secret);
      });

      it('F3 refused reconnect: answers 500 and leaves the connection and credential unchanged', async () => {
        expect((await completeSignIn()).status).toBe(200);
        const connections = await connectionRows();
        const credentials = await credentialRows();
        await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, userId));
        token = 'tok-B';
        await refuseAuditInserts(db);
        expect((await completeSignIn()).status).toBe(500);
        expect(await connectionRows()).toEqual(connections);
        expect(await credentialRows()).toEqual(credentials);
        await allowAuditInserts(db);
        expect(await auditFor(userId, 'integration.connection.reconnect')).toEqual([]);
      });

      it('F4 reconnect refreshes the credential and writes exactly one reconnect row', async () => {
        expect((await completeSignIn()).status).toBe(200);
        const [credentialBefore] = await credentialRows();
        await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, userId));
        token = 'tok-B';
        expect((await completeSignIn()).status).toBe(200);
        const [credentialAfter] = await credentialRows();
        expect(credentialAfter!.secretEncrypted).not.toBe(credentialBefore!.secretEncrypted);
        expect(await connectionRows()).toHaveLength(1);
        const rows = await auditFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: 'integration.connection.reconnect' });
      });

      it('F4b reconnect takes back the refusal a refresh recorded: lastError and refreshRefusedAt are null', async () => {
        expect((await completeSignIn()).status).toBe(200);
        const [connection] = await connectionRows();
        await db
          .update(schema.integrationConnections)
          .set({
            lastError:
              "The provider refused this connection's OAuth client (invalid_client); its client secret may be missing or wrong.",
            refreshRefusedAt: new Date('2026-01-01T00:00:00Z'),
          })
          .where(eq(schema.integrationConnections.id, connection!.id));
        token = 'tok-B';
        expect((await completeSignIn()).status).toBe(200);
        const [after] = await connectionRows();
        expect(after).toMatchObject({
          id: connection!.id,
          status: 'connected',
          lastError: null,
          refreshRefusedAt: null,
        });
      });

      describe('a provider that is not a forge', () => {
        const client: ResolvedOauthClient = {
          clientId: 'stub-client',
          clientSecret: 'stub-secret',
          source: 'env',
        };
        const signIn = () =>
          finishSignIn({
            db,
            userId,
            spec: h.stub as unknown as IntegrationProviderSpec,
            method: h.stub.auth[0] as never,
            client,
            tokens: { accessToken: 'tok-stub', refreshToken: null, expiresAt: null, scopes: null },
            requestedScopes: ['files.read'],
          });

        it('F5 refused: rejects and writes no connection', async () => {
          await refuseAuditInserts(db);
          await expect(signIn()).rejects.toThrow();
          expect(await connectionRows()).toEqual([]);
        });

        it('F6 keeps the token on the connection and writes one audit row', async () => {
          await expect(signIn()).resolves.toBeDefined();
          const [connection] = await connectionRows();
          expect(connection!.accessTokenEncrypted).not.toBeNull();
          expect(connection!.repoCredentialId).toBeNull();
          const rows = await auditFor(userId);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ action: 'integration.connection.create' });
          expect(rows[0]!.metadata).toEqual({
            providerId: h.stub.id,
            authMethod: 'oauth2',
            clientSource: 'env',
            credentialBacked: false,
          });
        });
      });
    });

    describe('DELETE /integrations/connections/:id', () => {
      const remove = (id: string) => send('user', 'DELETE', `/integrations/connections/${id}`);

      it('G1 stays best effort after the vendor revoke that cannot be undone: a refused row still answers 200', async () => {
        const connection = await seedConnection((await seedCredential()).id);
        await refuseAuditInserts(db);
        const res = await remove(connection.id);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, revoked: 'n/a' });
        expect(await connectionRows()).toEqual([]);
        await allowAuditInserts(db);
        expect(await auditFor(userId)).toEqual([]);
      });

      it('G2 disconnects and writes exactly one audit row', async () => {
        const connection = await seedConnection((await seedCredential()).id);
        expect((await remove(connection.id)).status).toBe(200);
        const rows = await auditFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'integration.connection.disconnect',
          targetId: connection.id,
        });
        expect(rows[0]!.metadata).toEqual({
          providerId: 'github',
          credentialBacked: true,
          revoked: 'n/a',
        });
      });
    });
  },
);
