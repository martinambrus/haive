import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.MUST_CHANGE_PASSWORD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/must_change_password_test'))
  throw new Error('Use a dedicated must_change_password_test database for the password gate tests');

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return { db: undefined as unknown };
});

const FIELD_KEY = generateEncryptionKey();
const PEPPER = 'ef'.repeat(32);

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getFresh: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
    getEncryptionKey: async () => FIELD_KEY,
    setIfAbsent: async () => undefined,
  },
}));

import {
  computeEmailBlindIndex,
  encryptEmail,
  generateEncryptionKey,
  secretsService,
} from '@haive/shared';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { hashPassword } from '../src/auth/password.js';
import { createApiApp } from '../src/index.js';

const MUST_CHANGE = 'must_change_password';
const PASSWORD = 'flagged-password-1';
const OTHER_PASSWORD = 'a-different-password-2';
const UUID = '00000000-0000-4000-8000-000000000001';
const sqlTruncate = sql.raw('TRUNCATE users CASCADE');

interface TestUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

describe.skipIf(!url)('a user who must change their password, on Postgres', () => {
  let db: Database;
  let app: ReturnType<typeof createApiApp>;
  let passwordHash: string;
  const created: string[] = [];

  const send = (
    method: string,
    path: string,
    opts: { cookie?: string; body?: unknown } = {},
  ): Promise<Response> | Response =>
    app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  const makeUser = async (
    overrides: Partial<typeof schema.users.$inferInsert> = {},
  ): Promise<TestUser> => {
    const email = `${randomUUID()}@must-change.test.local`;
    const [row] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: encryptEmail(email, FIELD_KEY),
        emailBlindIndex: computeEmailBlindIndex(email, PEPPER),
        passwordHash,
        role: 'user',
        ...overrides,
      })
      .returning({ id: schema.users.id, role: schema.users.role });
    created.push(row!.id);
    return { id: row!.id, email, role: row!.role };
  };

  const userRow = async (id: string) => {
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    return row!;
  };

  const accessCookie = async (user: TestUser, tv = 0) =>
    `${ACCESS_COOKIE}=${await signAccessToken({ sub: user.id, role: user.role, tv })}`;

  const cookiesOf = (res: Response) => {
    const set = res.headers.getSetCookie();
    const value = (name: string) =>
      set
        .find((line) => line.startsWith(`${name}=`))
        ?.split(';')[0]!
        .slice(name.length + 1);
    return { access: value(ACCESS_COOKIE), refresh: value(REFRESH_COOKIE), set };
  };

  const jar = (res: Response) => {
    const { access, refresh } = cookiesOf(res);
    return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`;
  };

  const login = (email: string, password: string) =>
    send('POST', '/auth/login', { body: { email, password } });

  const byAddress = (email: string) =>
    db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.emailBlindIndex, computeEmailBlindIndex(email, PEPPER)));

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    app = createApiApp('http://localhost:3000');
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(() => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    vi.spyOn(secretsService, 'getEmailBlindIndexPepper').mockResolvedValue(PEPPER);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of created.splice(0)) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  describe('a flagged user (role user)', () => {
    let user: TestUser;
    let cookie: string;

    beforeEach(async () => {
      user = await makeUser({ mustChangePassword: true, name: 'before' });
      cookie = await accessCookie(user);
    });

    const expectGated = async (res: Response) => {
      expect(res.status).toBe(403);
      expect((await json(res)).code).toBe(MUST_CHANGE);
    };

    it('MC-1: GET /tasks answers 403 must_change_password', async () => {
      await expectGated(await send('GET', '/tasks', { cookie }));
    });

    it('MC-2: account, tasks, repos, CLI catalog and IDE are all gated and nothing is written', async () => {
      await expectGated(await send('GET', '/user-settings/account', { cookie }));
      await expectGated(
        await send('PUT', '/user-settings/account', { cookie, body: { name: 'x' } }),
      );
      await expectGated(await send('POST', '/tasks', { cookie, body: {} }));
      await expectGated(await send('GET', '/repos', { cookie }));
      await expectGated(await send('GET', '/cli-providers/catalog', { cookie }));
      await expectGated(await send('GET', `/ide/${UUID}/`, { cookie }));
      expect((await userRow(user.id)).name).toBe('before');
    });

    it('MC-4: GET /auth/me answers 200 and reports mustChangePassword', async () => {
      const res = await send('GET', '/auth/me', { cookie });
      expect(res.status).toBe(200);
      expect((await json(res)).user.mustChangePassword).toBe(true);
    });

    it('MC-5: POST /auth/logout revokes the refresh token and clears both cookies', async () => {
      const session = await login(user.email, PASSWORD);
      expect(session.status).toBe(200);
      const { refresh } = cookiesOf(session);
      const res = await send('POST', '/auth/logout', { cookie: jar(session) });
      expect(res.status).toBe(200);
      const cleared = res.headers.getSetCookie();
      expect(cleared.some((line) => line.startsWith(`${ACCESS_COOKIE}=;`))).toBe(true);
      expect(cleared.some((line) => line.startsWith(`${REFRESH_COOKIE}=;`))).toBe(true);
      const rows = await db
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.userId, user.id));
      const row = rows.find(
        (r) => r.tokenHash === createHash('sha256').update(refresh!).digest('hex'),
      );
      expect(row?.revokedAt).toBeInstanceOf(Date);
    });

    it('MC-6: POST /auth/refresh answers 200 with new cookies', async () => {
      const session = await login(user.email, PASSWORD);
      const res = await send('POST', '/auth/refresh', { cookie: jar(session) });
      expect(res.status).toBe(200);
      const next = cookiesOf(res);
      expect(next.access).toBeTruthy();
      expect(next.refresh).toBeTruthy();
      expect(next.refresh).not.toBe(cookiesOf(session).refresh);
    });

    it('MC-7: PUT /user-settings/password with a different new password clears the flag and the gate', async () => {
      const res = await send('PUT', '/user-settings/password', {
        cookie,
        body: { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD },
      });
      expect(res.status).toBe(200);
      expect(await userRow(user.id)).toMatchObject({ mustChangePassword: false, tokenVersion: 1 });
      const fresh = cookiesOf(res);
      expect(fresh.access).toBeTruthy();
      expect(fresh.refresh).toBeTruthy();
      expect((await send('GET', '/tasks', { cookie: jar(res) })).status).toBe(200);
      expect((await send('GET', '/tasks', { cookie })).status).toBe(401);
    });

    it('MC-8: PUT /user-settings/password with a wrong current password answers 401 and keeps the flag', async () => {
      const res = await send('PUT', '/user-settings/password', {
        cookie,
        body: { currentPassword: 'not-the-password-0', newPassword: OTHER_PASSWORD },
      });
      expect(res.status).toBe(401);
      expect((await userRow(user.id)).mustChangePassword).toBe(true);
    });

    it('MC-9: PUT /user-settings/password with new equal to current answers 400 password_unchanged', async () => {
      const res = await send('PUT', '/user-settings/password', {
        cookie,
        body: { currentPassword: PASSWORD, newPassword: PASSWORD },
      });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('password_unchanged');
      expect(await userRow(user.id)).toMatchObject({ mustChangePassword: true, tokenVersion: 0 });
    });
  });

  describe('a flagged admin', () => {
    it('MC-3: the admin api is gated and creates nothing', async () => {
      const admin = await makeUser({ role: 'admin', mustChangePassword: true });
      const cookie = await accessCookie(admin);
      const email = `new-${randomUUID()}@must-change.test.local`;
      const list = await send('GET', '/admin/users', { cookie });
      expect(list.status).toBe(403);
      expect((await json(list)).code).toBe(MUST_CHANGE);
      const create = await send('POST', '/admin/users', { cookie, body: { email, role: 'user' } });
      expect(create.status).toBe(403);
      expect((await json(create)).code).toBe(MUST_CHANGE);
      const inserted = await byAddress(email);
      created.push(...inserted.map((r) => r.id));
      expect(inserted).toEqual([]);
    });
  });

  describe('an unflagged user', () => {
    let user: TestUser;
    let cookie: string;

    beforeEach(async () => {
      user = await makeUser({ name: 'before' });
      cookie = await accessCookie(user);
    });

    it('MC-10: the routes that MC-1 and MC-2 gate answer, and an unchanged password is accepted', async () => {
      expect((await send('GET', '/tasks', { cookie })).status).toBe(200);
      expect((await send('GET', '/user-settings/account', { cookie })).status).toBe(200);
      expect(
        (await send('PUT', '/user-settings/account', { cookie, body: { name: 'x' } })).status,
      ).toBe(200);
      expect((await userRow(user.id)).name).toBe('x');
      expect((await send('GET', '/repos', { cookie })).status).toBe(200);
      expect((await send('GET', '/cli-providers/catalog', { cookie })).status).toBe(200);
      const ide = await send('GET', `/ide/${UUID}/`, { cookie });
      expect(ide.status).toBe(404);

      const res = await send('PUT', '/user-settings/password', {
        cookie,
        body: { currentPassword: PASSWORD, newPassword: PASSWORD },
      });
      expect(res.status).toBe(200);
      expect(await userRow(user.id)).toMatchObject({ mustChangePassword: false, tokenVersion: 1 });
    });
  });

  describe('a user an administrator creates or resets', () => {
    it('MC-11: the temporary password reaches only the password change, then the app opens', async () => {
      const admin = await makeUser({ role: 'admin' });
      const email = `new-${randomUUID()}@must-change.test.local`;
      const create = await send('POST', '/admin/users', {
        cookie: await accessCookie(admin),
        body: { email, role: 'user' },
      });
      expect(create.status).toBe(201);
      const body = await json(create);
      created.push(body.user.id);
      const temporaryPassword = body.temporaryPassword as string;
      expect(temporaryPassword).toBeTruthy();

      const session = await login(email, temporaryPassword);
      expect(session.status).toBe(200);
      const gated = await send('GET', '/tasks', { cookie: jar(session) });
      expect(gated.status).toBe(403);
      expect((await json(gated)).code).toBe(MUST_CHANGE);

      const changed = await send('PUT', '/user-settings/password', {
        cookie: jar(session),
        body: { currentPassword: temporaryPassword, newPassword: OTHER_PASSWORD },
      });
      expect(changed.status).toBe(200);
      expect((await send('GET', '/tasks', { cookie: jar(changed) })).status).toBe(200);
    });

    it('MC-12: reset_password flags the target, ends its session and gates its next login', async () => {
      const admin = await makeUser({ role: 'admin' });
      const target = await makeUser();
      const oldCookie = await accessCookie(target);
      expect((await send('GET', '/tasks', { cookie: oldCookie })).status).toBe(200);

      const reset = await send('POST', `/admin/users/${target.id}/action`, {
        cookie: await accessCookie(admin),
        body: { action: 'reset_password' },
      });
      expect(reset.status).toBe(200);
      const temporaryPassword = (await json(reset)).temporaryPassword as string;
      expect((await userRow(target.id)).mustChangePassword).toBe(true);
      expect((await send('GET', '/tasks', { cookie: oldCookie })).status).toBe(401);

      const session = await login(target.email, temporaryPassword);
      expect(session.status).toBe(200);
      const gated = await send('GET', '/tasks', { cookie: jar(session) });
      expect(gated.status).toBe(403);
      expect((await json(gated)).code).toBe(MUST_CHANGE);
    });
  });

  describe('a request that is not authenticated at all', () => {
    it('MC-14: no cookie, a deactivated flagged user and a stale flagged session each answer 401', async () => {
      expect((await send('GET', '/tasks')).status).toBe(401);

      const deactivated = await makeUser({ mustChangePassword: true, status: 'deactivated' });
      expect(
        (await send('GET', '/tasks', { cookie: await accessCookie(deactivated) })).status,
      ).toBe(401);

      const stale = await makeUser({ mustChangePassword: true, tokenVersion: 3 });
      expect((await send('GET', '/tasks', { cookie: await accessCookie(stale, 0) })).status).toBe(
        401,
      );
    });
  });

  describe('setup flow', () => {
    beforeEach(async () => {
      await db.execute(sqlTruncate);
    });

    afterAll(async () => {
      await db.execute(sqlTruncate);
    });

    it('MC-13: the first administrator registers into an open app, and so does an invited user', async () => {
      const email = `first-${randomUUID()}@must-change.test.local`;
      const first = await send('POST', '/auth/register', {
        body: { email, password: PASSWORD },
      });
      expect(first.status).toBe(201);
      const firstBody = await json(first);
      expect(firstBody.user.role).toBe('admin');
      expect((await send('GET', '/tasks', { cookie: jar(first) })).status).toBe(200);
      expect((await userRow(firstBody.user.id)).mustChangePassword).toBe(false);

      const token = randomBytes(32).toString('base64url');
      await db.insert(schema.userInvites).values({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        role: 'user',
        createdBy: firstBody.user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const invitedEmail = `invited-${randomUUID()}@must-change.test.local`;
      const invited = await send('POST', '/auth/register', {
        body: { email: invitedEmail, password: PASSWORD, inviteToken: token },
      });
      expect(invited.status).toBe(201);
      const invitedBody = await json(invited);
      expect(invitedBody.user.role).toBe('user');
      expect((await send('GET', '/tasks', { cookie: jar(invited) })).status).toBe(200);
      expect((await userRow(invitedBody.user.id)).mustChangePassword).toBe(false);
    });
  });
});
