import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.TOOLING_APP_AUTH_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/tooling_app_auth_test'))
  throw new Error('Use a dedicated tooling_app_auth_test database for the app-login route tests');

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return { db: undefined as unknown };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
  },
}));

import { secretsService, userSecretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';

const KEK = 'ab'.repeat(32);
const ACTION = 'repository.app_auth.update';
const OLD = { username: 'old-user-4d2', password: 'old-pass-8e1' };
const NEXT = { username: 'next-user-7a9', password: 'next-pass-3c6' };

describe.skipIf(!url)('PATCH /repositories/:id/tooling app-login credentials, on Postgres', () => {
  let db: Database;
  let app: ReturnType<typeof createApiApp>;
  let userId: string;
  let cookie: string;
  let repositoryId: string;

  const keyOf = (suffix: 'username' | 'password') => `app_auth:${repositoryId}:${suffix}`;

  const patch = (body: Record<string, unknown>) =>
    app.request(`/repositories/${repositoryId}/tooling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  const stored = async () => ({
    username: await userSecretsService.get(userId, keyOf('username')),
    password: await userSecretsService.get(userId, keyOf('password')),
  });

  const audited = () =>
    db
      .select()
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.actorUserId, userId), eq(schema.auditEvents.action, ACTION)),
      );

  function failPasswordWrite() {
    const write = userSecretsService.set.bind(userSecretsService);
    return vi
      .spyOn(userSecretsService, 'set')
      .mockImplementation((...args) =>
        args[1] === keyOf('password')
          ? Promise.reject(new Error('secret store unavailable'))
          : write(...args),
      );
  }

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await userSecretsService.initialize(db, KEK);
    app = createApiApp('http://localhost:3000');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'tooling-app-auth-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role: 'user',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;
    cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    const [repository] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'app auth atomic', source: 'local_path' })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
    await userSecretsService.set(userId, keyOf('username'), OLD.username, 'App login username');
    await userSecretsService.set(userId, keyOf('password'), OLD.password, 'App login password');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it('stores both and records one event when the request changes both', async () => {
    const res = await patch({ appAuthUsername: NEXT.username, appAuthPassword: NEXT.password });

    expect(res.status).toBe(200);
    expect(await stored()).toEqual(NEXT);
    const rows = await audited();
    expect(rows.map((row) => row.metadata)).toStrictEqual([{ username: 'set', password: 'set' }]);
    expect(rows[0]).toMatchObject({ targetType: 'repository', targetId: repositoryId });
  });

  it('removes both and records one event when the request clears both', async () => {
    const res = await patch({ appAuthUsername: '', appAuthPassword: '' });

    expect(res.status).toBe(200);
    expect(await stored()).toEqual({ username: null, password: null });
    const rows = await audited();
    expect(rows.map((row) => row.metadata)).toStrictEqual([
      { username: 'cleared', password: 'cleared' },
    ]);
  });

  describe('when the password write throws after the username write', () => {
    let write: ReturnType<typeof failPasswordWrite>;
    let res: Response;

    beforeEach(async () => {
      write = failPasswordWrite();
      res = await patch({ appAuthUsername: NEXT.username, appAuthPassword: NEXT.password });
    });

    it('fails the request, having attempted the username first', () => {
      expect(res.status).toBe(500);
      expect(write.mock.calls.map(([, key]) => key)).toEqual([
        keyOf('username'),
        keyOf('password'),
      ]);
    });

    it('leaves the stored pair as it was', async () => {
      expect(await stored()).toEqual(OLD);
    });

    it('records no event', async () => {
      expect(await audited()).toEqual([]);
    });
  });
});
