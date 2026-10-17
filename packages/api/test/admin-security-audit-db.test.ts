import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.ADMIN_SECURITY_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/admin_security_audit_test'))
  throw new Error('Use a dedicated admin_security_audit_test database for the admin audit tests');

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
  },
}));

import { computeEmailBlindIndex, generateEncryptionKey, secretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';

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

describe.skipIf(!url)(
  'admin security actions write their audit row in the same transaction, on Postgres',
  () => {
    let db: Database;
    let app: ReturnType<typeof createApiApp>;
    let actorId: string;
    let cookie: string;
    const targets: string[] = [];
    const blindIndexes: string[] = [];

    const send = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const makeUser = async (overrides: Partial<typeof schema.users.$inferInsert> = {}) => {
      const [row] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: `${randomUUID()}@admin-audit.test.local`,
          emailBlindIndex: randomBytes(16).toString('hex'),
          passwordHash: 'not-a-real-hash',
          role: 'user',
          ...overrides,
        })
        .returning({ id: schema.users.id });
      targets.push(row!.id);
      return row!.id;
    };

    const userRow = async (id: string) => {
      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id));
      return row!;
    };

    const auditRows = (action: string) =>
      db
        .select()
        .from(schema.auditEvents)
        .where(
          and(eq(schema.auditEvents.actorUserId, actorId), eq(schema.auditEvents.action, action)),
        );

    beforeAll(async () => {
      db = createDatabase(url as string);
      h.db = db;
      app = createApiApp('http://localhost:3000');
    });

    afterAll(async () => {
      await db.$client.end({ timeout: 5 });
    });

    beforeEach(async () => {
      vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
      vi.spyOn(secretsService, 'getEmailBlindIndexPepper').mockResolvedValue(PEPPER);
      const [actor] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: `${randomUUID()}@admin-audit.test.local`,
          emailBlindIndex: randomBytes(16).toString('hex'),
          passwordHash: 'not-a-real-hash',
          role: 'admin',
        })
        .returning({ id: schema.users.id });
      actorId = actor!.id;
      cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: actorId, role: 'admin', tv: 0 })}`;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await allowAuditInserts(db);
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, actorId));
      await db.delete(schema.userInvites).where(eq(schema.userInvites.createdBy, actorId));
      for (const index of blindIndexes.splice(0)) {
        await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, index));
      }
      for (const id of targets.splice(0)) {
        await db.delete(schema.users).where(eq(schema.users.id, id));
      }
      await db.delete(schema.users).where(eq(schema.users.id, actorId));
    });

    describe('POST /admin/users', () => {
      const address = () => `new-${randomUUID()}@admin-audit.test.local`;
      const byAddress = (email: string) =>
        db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.emailBlindIndex, computeEmailBlindIndex(email, PEPPER)));

      it('refused: answers 500 and leaves no user row', async () => {
        const email = address();
        blindIndexes.push(computeEmailBlindIndex(email, PEPPER));
        await refuseAuditInserts(db);
        const res = await send('POST', '/admin/users', { email, role: 'user' });
        expect(res.status).toBe(500);
        expect(await byAddress(email)).toEqual([]);
        await allowAuditInserts(db);
        expect(await auditRows('user.create')).toEqual([]);
      });

      it('success: answers 201, keeps the row, and writes one audit row', async () => {
        const email = address();
        blindIndexes.push(computeEmailBlindIndex(email, PEPPER));
        const res = await send('POST', '/admin/users', { email, role: 'user' });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { user: { id: string } };
        expect(await byAddress(email)).toHaveLength(1);
        const rows = await auditRows('user.create');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ targetType: 'user', targetId: body.user.id });
      });
    });

    describe('POST /admin/users/:id/action', () => {
      const act = (id: string, body: Record<string, unknown>) =>
        send('POST', `/admin/users/${id}/action`, body);

      it('deactivate: refused leaves the row unchanged; success deactivates and audits', async () => {
        const target = await makeUser();
        const before = await userRow(target);
        await refuseAuditInserts(db);
        expect((await act(target, { action: 'deactivate' })).status).toBe(500);
        expect(await userRow(target)).toEqual(before);
        await allowAuditInserts(db);
        expect(await auditRows('user.deactivate')).toEqual([]);

        const res = await act(target, { action: 'deactivate' });
        expect(res.status).toBe(200);
        expect(await userRow(target)).toMatchObject({
          status: 'deactivated',
          tokenVersion: before.tokenVersion + 1,
        });
        const rows = await auditRows('user.deactivate');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.targetId).toBe(target);
      });

      it('activate: refused leaves the row unchanged; success activates and audits', async () => {
        const target = await makeUser({ status: 'deactivated' });
        const before = await userRow(target);
        await refuseAuditInserts(db);
        expect((await act(target, { action: 'activate' })).status).toBe(500);
        expect(await userRow(target)).toEqual(before);
        await allowAuditInserts(db);
        expect(await auditRows('user.activate')).toEqual([]);

        expect((await act(target, { action: 'activate' })).status).toBe(200);
        expect((await userRow(target)).status).toBe('active');
        const rows = await auditRows('user.activate');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.targetId).toBe(target);
      });

      it('reset_password: refused leaves the password and session unchanged; success audits', async () => {
        const target = await makeUser();
        const before = await userRow(target);
        await refuseAuditInserts(db);
        expect((await act(target, { action: 'reset_password' })).status).toBe(500);
        expect(await userRow(target)).toEqual(before);
        await allowAuditInserts(db);
        expect(await auditRows('user.reset_password')).toEqual([]);

        const res = await act(target, { action: 'reset_password' });
        expect(res.status).toBe(200);
        expect(await userRow(target)).toMatchObject({ mustChangePassword: true });
        const rows = await auditRows('user.reset_password');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.targetId).toBe(target);
      });

      it('set_role: refused leaves the role unchanged; success changes it and audits', async () => {
        const target = await makeUser({ role: 'user' });
        const before = await userRow(target);
        await refuseAuditInserts(db);
        expect((await act(target, { action: 'set_role', role: 'admin' })).status).toBe(500);
        expect(await userRow(target)).toEqual(before);
        await allowAuditInserts(db);
        expect(await auditRows('user.set_role')).toEqual([]);

        expect((await act(target, { action: 'set_role', role: 'admin' })).status).toBe(200);
        expect((await userRow(target)).role).toBe('admin');
        const rows = await auditRows('user.set_role');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ targetId: target, metadata: { role: 'admin' } });
      });
    });

    describe('invites', () => {
      const inviteRows = () =>
        db.select().from(schema.userInvites).where(eq(schema.userInvites.createdBy, actorId));

      const makeInvite = async () => {
        const [row] = await db
          .insert(schema.userInvites)
          .values({
            tokenHash: randomUUID(),
            role: 'user',
            createdBy: actorId,
            expiresAt: new Date(Date.now() + 3_600_000),
          })
          .returning({ id: schema.userInvites.id });
        return row!.id;
      };

      it('POST: refused leaves no invite row; success answers 201 and audits without the token', async () => {
        await refuseAuditInserts(db);
        const refused = await send('POST', '/admin/invites', { role: 'user', expiresInHours: 24 });
        expect(refused.status).toBe(500);
        expect(await inviteRows()).toEqual([]);
        await allowAuditInserts(db);
        expect(await auditRows('invite.create')).toEqual([]);

        const res = await send('POST', '/admin/invites', { role: 'user', expiresInHours: 24 });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { id: string };
        expect(await inviteRows()).toHaveLength(1);
        const rows = await auditRows('invite.create');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ targetId: body.id });
        expect(JSON.stringify(rows[0]!.metadata)).not.toContain('token');
      });

      it('DELETE: refused leaves the invite outstanding; success revokes it and audits', async () => {
        const id = await makeInvite();
        const [before] = await inviteRows();
        await refuseAuditInserts(db);
        expect((await send('DELETE', `/admin/invites/${id}`)).status).toBe(500);
        const [still] = await inviteRows();
        expect(still!.revokedAt).toBeNull();
        expect(still).toEqual(before);
        await allowAuditInserts(db);
        expect(await auditRows('invite.revoke')).toEqual([]);

        expect((await send('DELETE', `/admin/invites/${id}`)).status).toBe(200);
        const [revoked] = await inviteRows();
        expect(revoked!.revokedAt).toBeInstanceOf(Date);
        const rows = await auditRows('invite.revoke');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.targetId).toBe(id);
      });
    });
  },
);
