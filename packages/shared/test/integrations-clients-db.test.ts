import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { secretsService } from '../src/config/secrets.service.js';
import { envelopeEncrypt } from '../src/crypto/index.js';
import {
  isProviderEnabled,
  resolveOauthClient,
  resolveOauthClientById,
} from '../src/integrations/index.js';

const url = process.env.INTEGRATIONS_CLIENTS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integrations_clients_test'))
  throw new Error('Use a dedicated integrations_clients_test database for the client tests');

const KEK = 'ab'.repeat(32);
const ENV = { id: 'stub-env-client-id', secret: 'stub-env-client-secret' };
const USER_CLIENT_ID = 'stub-user-client-id';
const ADMIN = { id: 'stub-admin-client-id', secret: 'stub-admin-client-secret' };
const MODULE_PROVIDER = 'module.drive-x.google-docs';

describe.skipIf(!url)('OAuth clients and provider enablement on Postgres', () => {
  let db: Database;
  const userIds: string[] = [];

  async function createUser(): Promise<string> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'clients-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    return user!.id;
  }

  async function setUserClientId(userId: string, clientId: string) {
    const envelope = envelopeEncrypt(clientId, KEK);
    await db.insert(schema.userSecrets).values({
      userId,
      keyName: 'github_client_id',
      encryptedValue: envelope.encryptedValue,
      encryptedDek: envelope.encryptedDek,
    });
  }

  async function setProviderRow(
    providerId: string,
    over: Partial<typeof schema.integrationProviderConfigs.$inferInsert>,
  ) {
    await db
      .insert(schema.integrationProviderConfigs)
      .values({ providerId, ...over })
      .onConflictDoUpdate({ target: schema.integrationProviderConfigs.providerId, set: over });
  }

  async function setAdminClient(providerId: string, clientId: string, secret: string | null) {
    const envelope = secret === null ? null : envelopeEncrypt(secret, KEK);
    await setProviderRow(providerId, {
      oauthClientId: clientId,
      oauthClientSecretEncrypted: envelope?.encryptedValue ?? null,
      encryptedDek: envelope?.encryptedDek ?? null,
    });
  }

  beforeAll(() => {
    db = createDatabase(url as string);
  });

  beforeEach(async () => {
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
    await db.delete(schema.integrationProviderConfigs);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await db.delete(schema.integrationProviderConfigs);
    if (userIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  describe('resolveOauthClient for github', () => {
    const device = { clientId: ENV.id, clientSecret: ENV.secret, source: 'env' } as const;

    // [env present, user present, admin present] -> the client each method gets.
    // The user client is an id with no secret, so a code flow cannot use it.
    const matrix = [
      [[false, false, false], null, null],
      [[true, false, false], device, device],
      [
        [false, true, false],
        { clientId: USER_CLIENT_ID, clientSecret: null, source: 'user' },
        null,
      ],
      [[true, true, false], device, device],
      [
        [false, false, true],
        { clientId: ADMIN.id, clientSecret: ADMIN.secret, source: 'admin' },
        { clientId: ADMIN.id, clientSecret: ADMIN.secret, source: 'admin' },
      ],
      [[true, false, true], device, device],
      [
        [false, true, true],
        { clientId: USER_CLIENT_ID, clientSecret: null, source: 'user' },
        { clientId: ADMIN.id, clientSecret: ADMIN.secret, source: 'admin' },
      ],
      [[true, true, true], device, device],
    ] as const;

    it.each(matrix)(
      'with env, user, admin present as %j, hands device and oauth2 the right client',
      async ([env, user, admin], forDevice, forOauth2) => {
        if (env) {
          vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', ENV.id);
          vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', ENV.secret);
        }
        const userId = await createUser();
        if (user) await setUserClientId(userId, USER_CLIENT_ID);
        if (admin) await setAdminClient('github', ADMIN.id, ADMIN.secret);

        expect(await resolveOauthClient(db, 'github', userId, 'device')).toEqual(forDevice);
        expect(await resolveOauthClient(db, 'github', userId, 'oauth2')).toEqual(forOauth2);
      },
    );

    it('takes an env client id that has no env secret whole, never with the admin secret', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', ENV.id);
      const userId = await createUser();
      await setAdminClient('github', ADMIN.id, ADMIN.secret);
      expect(await resolveOauthClient(db, 'github', userId, 'device')).toEqual({
        clientId: ENV.id,
        clientSecret: null,
        source: 'env',
      });
      expect(await resolveOauthClient(db, 'github', userId, 'oauth2')).toEqual({
        clientId: ADMIN.id,
        clientSecret: ADMIN.secret,
        source: 'admin',
      });
    });

    it('ignores an env secret that has no env client id', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', ENV.secret);
      const userId = await createUser();
      expect(await resolveOauthClient(db, 'github', userId, 'oauth2')).toBeNull();
    });

    it('skips an admin client that has no secret for a code flow, and serves a device flow', async () => {
      const userId = await createUser();
      await setAdminClient('github', ADMIN.id, null);
      expect(await resolveOauthClient(db, 'github', userId, 'oauth2')).toBeNull();
      expect(await resolveOauthClient(db, 'github', userId, 'device')).toEqual({
        clientId: ADMIN.id,
        clientSecret: null,
        source: 'admin',
      });
    });

    it('finds no client in a provider row that holds only the enabled flag', async () => {
      const userId = await createUser();
      await setProviderRow('github', { enabled: true });
      expect(await resolveOauthClient(db, 'github', userId, 'device')).toBeNull();
    });

    it("reads each user's own client id, not another user's", async () => {
      const mine = await createUser();
      const theirs = await createUser();
      await setUserClientId(theirs, USER_CLIENT_ID);
      expect(await resolveOauthClient(db, 'github', mine, 'device')).toBeNull();
      expect(await resolveOauthClient(db, 'github', theirs, 'device')).toMatchObject({
        clientId: USER_CLIENT_ID,
        source: 'user',
      });
    });
  });

  describe('resolveOauthClient for every other provider', () => {
    it('uses the admin row only, whatever the env and the user have for github', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', ENV.id);
      vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', ENV.secret);
      const userId = await createUser();
      await setUserClientId(userId, USER_CLIENT_ID);
      expect(await resolveOauthClient(db, 'gitlab', userId, 'device')).toBeNull();
      expect(await resolveOauthClient(db, MODULE_PROVIDER, userId, 'oauth2')).toBeNull();

      await setAdminClient('gitlab', ADMIN.id, ADMIN.secret);
      await setAdminClient(MODULE_PROVIDER, 'stub-module-client-id', 'stub-module-secret');
      expect(await resolveOauthClient(db, 'gitlab', userId, 'oauth2')).toEqual({
        clientId: ADMIN.id,
        clientSecret: ADMIN.secret,
        source: 'admin',
      });
      expect(await resolveOauthClient(db, MODULE_PROVIDER, userId, 'device')).toEqual({
        clientId: 'stub-module-client-id',
        clientSecret: 'stub-module-secret',
        source: 'admin',
      });
    });

    it('treats a provider id that is also an Object property like any other provider', async () => {
      const userId = await createUser();
      expect(await resolveOauthClient(db, 'constructor', userId, 'device')).toBeNull();
    });

    it('keeps the client secret as ciphertext in the row and decrypts it on the way out', async () => {
      const userId = await createUser();
      await setAdminClient('gitlab', ADMIN.id, ADMIN.secret);
      const [row] = await db
        .select()
        .from(schema.integrationProviderConfigs)
        .where(eq(schema.integrationProviderConfigs.providerId, 'gitlab'));
      expect(row?.oauthClientSecretEncrypted).toBeTypeOf('string');
      expect(row?.oauthClientSecretEncrypted).not.toBe(ADMIN.secret);
      expect(JSON.stringify(row)).not.toContain(ADMIN.secret);
      expect((await resolveOauthClient(db, 'gitlab', userId, 'oauth2'))?.clientSecret).toBe(
        ADMIN.secret,
      );
    });
  });

  describe('resolveOauthClientById', () => {
    const env = { clientId: ENV.id, clientSecret: ENV.secret, source: 'env' } as const;
    const user = { clientId: USER_CLIENT_ID, clientSecret: null, source: 'user' } as const;
    const admin = { clientId: ADMIN.id, clientSecret: ADMIN.secret, source: 'admin' } as const;

    it('finds the source that holds the id whatever its priority, and only if it serves the method', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', ENV.id);
      vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', ENV.secret);
      const userId = await createUser();
      await setUserClientId(userId, USER_CLIENT_ID);
      await setAdminClient('github', ADMIN.id, ADMIN.secret);
      const byId = (method: 'device' | 'oauth2', clientId: string) =>
        resolveOauthClientById(db, 'github', userId, method, clientId);

      expect(await byId('device', ENV.id)).toEqual(env);
      expect(await byId('oauth2', ENV.id)).toEqual(env);
      expect(await byId('device', USER_CLIENT_ID)).toEqual(user);
      expect(await byId('oauth2', USER_CLIENT_ID)).toBeNull();
      expect(await byId('device', ADMIN.id)).toEqual(admin);
      expect(await byId('oauth2', ADMIN.id)).toEqual(admin);
      expect(await byId('device', 'stub-unknown-client-id')).toBeNull();
      expect(await byId('oauth2', 'stub-unknown-client-id')).toBeNull();
    });

    it('takes the first source, in priority order, that holds the id and serves the method', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', ADMIN.id);
      const userId = await createUser();
      await setAdminClient('github', ADMIN.id, ADMIN.secret);
      expect(await resolveOauthClientById(db, 'github', userId, 'device', ADMIN.id)).toEqual({
        clientId: ADMIN.id,
        clientSecret: null,
        source: 'env',
      });
      expect(await resolveOauthClientById(db, 'github', userId, 'oauth2', ADMIN.id)).toEqual(admin);
    });

    it('reads only the admin row for every other provider', async () => {
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', ENV.id);
      vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', ENV.secret);
      const userId = await createUser();
      await setUserClientId(userId, USER_CLIENT_ID);
      await setAdminClient('gitlab', ADMIN.id, ADMIN.secret);
      expect(await resolveOauthClientById(db, 'gitlab', userId, 'oauth2', ENV.id)).toBeNull();
      expect(
        await resolveOauthClientById(db, 'gitlab', userId, 'device', USER_CLIENT_ID),
      ).toBeNull();
      expect(await resolveOauthClientById(db, 'gitlab', userId, 'oauth2', ADMIN.id)).toEqual(admin);
    });
  });

  describe('isProviderEnabled', () => {
    it('is on for a core provider with no row, and off for a module provider with no row', async () => {
      expect(await isProviderEnabled(db, 'github')).toBe(true);
      expect(await isProviderEnabled(db, 'bitbucket_server')).toBe(true);
      expect(await isProviderEnabled(db, MODULE_PROVIDER)).toBe(false);
    });

    it('lets the row win, both ways', async () => {
      await setProviderRow('github', { enabled: false });
      await setProviderRow(MODULE_PROVIDER, { enabled: true });
      expect(await isProviderEnabled(db, 'github')).toBe(false);
      expect(await isProviderEnabled(db, MODULE_PROVIDER)).toBe(true);
      await setProviderRow('github', { enabled: true });
      await setProviderRow(MODULE_PROVIDER, { enabled: false });
      expect(await isProviderEnabled(db, 'github')).toBe(true);
      expect(await isProviderEnabled(db, MODULE_PROVIDER)).toBe(false);
    });

    it('is off for an id that is not a provider id at all', async () => {
      expect(await isProviderEnabled(db, 'Not A Provider')).toBe(false);
    });

    it('is off for a core-shaped id that no provider registers', async () => {
      expect(await isProviderEnabled(db, 'dropbox')).toBe(false);
    });
  });
});
