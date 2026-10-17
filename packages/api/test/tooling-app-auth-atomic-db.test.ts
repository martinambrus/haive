import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.TOOLING_APP_AUTH_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/tooling_app_auth_test'))
  throw new Error('Use a dedicated tooling_app_auth_test database for the app-login route tests');

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return { db: undefined as unknown, outbox: { fails: false, calls: 0 } };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
  },
}));
vi.mock('@haive/shared/project-state-outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/project-state-outbox')>();
  return {
    ...actual,
    markProjectStateDirty: async (...args: Parameters<typeof actual.markProjectStateDirty>) => {
      h.outbox.calls += 1;
      if (h.outbox.fails) throw new Error('project state outbox unavailable');
      return actual.markProjectStateDirty(...args);
    },
  };
});

import { secretsService, userSecretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';

const KEK = 'ab'.repeat(32);
const ACTION = 'repository.app_auth.update';
const OLD = { username: 'old-user-4d2', password: 'old-pass-8e1' };
const NEXT = { username: 'next-user-7a9', password: 'next-pass-3c6' };

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

  const storedRtkVersion = async () => {
    const [row] = await db
      .select({ rtkVersion: schema.repositories.rtkVersion })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId));
    return row!.rtkVersion;
  };

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
    h.outbox.fails = false;
    h.outbox.calls = 0;
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

  it('stores the setting and both credentials, and records one event, when nothing fails', async () => {
    const res = await patch({
      rtkVersion: '1.2.3',
      appAuthUsername: NEXT.username,
      appAuthPassword: NEXT.password,
    });

    expect(res.status).toBe(200);
    expect(h.outbox.calls).toBe(1);
    expect(await storedRtkVersion()).toBe('1.2.3');
    expect(await stored()).toEqual(NEXT);
    expect((await audited()).map((row) => row.metadata)).toStrictEqual([
      { username: 'set', password: 'set' },
    ]);
  });

  describe('the RTK switch', () => {
    const storedRtk = async () => {
      const [row] = await db
        .select({
          rtkEnabled: schema.repositories.rtkEnabled,
          madeAt: schema.repositories.rtkChoiceMadeAt,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repositoryId));
      return row!;
    };

    it('is stamped when a save changes it, and not when a save sends it again', async () => {
      expect((await patch({ rtkEnabled: true })).status).toBe(200);
      expect(await storedRtk()).toMatchObject({ rtkEnabled: true, madeAt: null });

      expect((await patch({ rtkEnabled: false })).status).toBe(200);
      const switched = await storedRtk();
      expect(switched.rtkEnabled).toBe(false);
      expect(switched.madeAt).toBeInstanceOf(Date);

      expect((await patch({ rtkEnabled: false, rtkVersion: '1.2.3' })).status).toBe(200);
      expect((await storedRtk()).madeAt).toEqual(switched.madeAt);
    });

    it('is neither switched nor stamped when a later write of the same request throws', async () => {
      h.outbox.fails = true;

      const res = await patch({ rtkEnabled: false });

      expect(res.status).toBe(500);
      expect(await storedRtk()).toMatchObject({ rtkEnabled: true, madeAt: null });
    });
  });

  describe('when a later write of the same request throws after both credentials were written', () => {
    let written: unknown[];
    let res: Response;

    beforeEach(async () => {
      const write = vi.spyOn(userSecretsService, 'set');
      h.outbox.fails = true;
      res = await patch({
        rtkVersion: '1.2.3',
        appAuthUsername: NEXT.username,
        appAuthPassword: NEXT.password,
      });
      written = write.mock.calls.map(([, key]) => key);
    });

    it('fails the request at the project state write, after both credential writes', () => {
      expect(res.status).toBe(500);
      expect(written).toEqual([keyOf('username'), keyOf('password')]);
      expect(h.outbox.calls).toBe(1);
    });

    it('leaves the stored pair and the setting as they were', async () => {
      expect(await stored()).toEqual(OLD);
      expect(await storedRtkVersion()).toBeNull();
    });

    it('records no event', async () => {
      expect(await audited()).toEqual([]);
    });
  });

  describe('when the audit insert is refused', () => {
    let res: Response;

    beforeEach(async () => {
      await refuseAuditInserts(db);
      res = await patch({
        rtkVersion: '1.2.3',
        appAuthUsername: NEXT.username,
        appAuthPassword: NEXT.password,
      });
    });

    afterEach(async () => {
      await allowAuditInserts(db);
    });

    it('fails the request, leaving the stored pair and the setting as they were', async () => {
      expect(res.status).toBe(500);
      expect(await stored()).toEqual(OLD);
      expect(await storedRtkVersion()).toBeNull();
    });

    it('records no event once the trigger is gone', async () => {
      await allowAuditInserts(db);
      expect(await audited()).toEqual([]);
    });
  });
});
