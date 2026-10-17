import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.REPO_CREDENTIALS_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repo_credentials_audit_test'))
  throw new Error(
    'Use a dedicated repo_credentials_audit_test database for the credential audit tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return { db: undefined as unknown };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getFresh: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
  },
}));

import { generateEncryptionKey, secretsService } from '@haive/shared';
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
  'repo credential actions write their audit row in the same transaction, on Postgres',
  () => {
    let db: Database;
    let app: ReturnType<typeof createApiApp>;
    let userId: string;
    let cookie: string;

    const send = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const credentialRow = async (id: string) => {
      const [row] = await db
        .select()
        .from(schema.repoCredentials)
        .where(eq(schema.repoCredentials.id, id));
      return row;
    };

    const credentialsLabelled = (label: string) =>
      db
        .select({ id: schema.repoCredentials.id })
        .from(schema.repoCredentials)
        .where(
          and(eq(schema.repoCredentials.userId, userId), eq(schema.repoCredentials.label, label)),
        );

    const makeCredential = async () => {
      const [row] = await db
        .insert(schema.repoCredentials)
        .values({
          userId,
          label: 'before',
          host: 'git.example.com',
          usernameEncrypted: 'x',
          secretEncrypted: 'x',
          encryptedDek: 'x',
        })
        .returning({ id: schema.repoCredentials.id });
      return row!.id;
    };

    const auditRows = (action: string) =>
      db
        .select()
        .from(schema.auditEvents)
        .where(
          and(eq(schema.auditEvents.actorUserId, userId), eq(schema.auditEvents.action, action)),
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
      vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(generateEncryptionKey());
      const [user] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: `${randomUUID()}@repo-credentials-audit.test.local`,
          emailBlindIndex: randomBytes(16).toString('hex'),
          passwordHash: 'not-a-real-hash',
          role: 'user',
        })
        .returning({ id: schema.users.id });
      userId = user!.id;
      cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await allowAuditInserts(db);
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    });

    const created = {
      label: 'created',
      host: 'git.example.com',
      username: 'ci-bot',
      secret: 'token-1',
    };

    it('POST: refused answers 500 and stores no credential', async () => {
      await refuseAuditInserts(db);
      const res = await send('POST', '/repo-credentials', { ...created, label: 'refused' });
      expect(res.status).toBe(500);
      expect(await credentialsLabelled('refused')).toEqual([]);
      await allowAuditInserts(db);
      expect(await auditRows('credential.create')).toEqual([]);
    });

    it('POST: success answers 201, keeps the credential, and writes one audit row', async () => {
      const res = await send('POST', '/repo-credentials', created);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { credential: { id: string } };
      expect(await credentialsLabelled('created')).toHaveLength(1);
      const rows = await auditRows('credential.create');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        targetType: 'repo_credential',
        targetId: body.credential.id,
      });
    });

    it('PUT: refused leaves the label and host unchanged', async () => {
      const id = await makeCredential();
      const before = await credentialRow(id);
      await refuseAuditInserts(db);
      const res = await send('PUT', `/repo-credentials/${id}`, {
        label: 'changed',
        host: 'git2.example.com',
      });
      expect(res.status).toBe(500);
      expect(await credentialRow(id)).toEqual(before);
      await allowAuditInserts(db);
      expect(await auditRows('credential.update')).toEqual([]);
    });

    it('PUT: success answers 200, changes the row, and writes one audit row', async () => {
      const id = await makeCredential();
      const res = await send('PUT', `/repo-credentials/${id}`, {
        label: 'changed',
        host: 'git2.example.com',
      });
      expect(res.status).toBe(200);
      expect(await credentialRow(id)).toMatchObject({ label: 'changed', host: 'git2.example.com' });
      const rows = await auditRows('credential.update');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetType: 'repo_credential', targetId: id });
    });

    it('DELETE: refused keeps the credential', async () => {
      const id = await makeCredential();
      const before = await credentialRow(id);
      await refuseAuditInserts(db);
      expect((await send('DELETE', `/repo-credentials/${id}`)).status).toBe(500);
      expect(await credentialRow(id)).toEqual(before);
      await allowAuditInserts(db);
      expect(await auditRows('credential.delete')).toEqual([]);
    });

    it('DELETE: success answers 200, removes the credential, and writes one audit row', async () => {
      const id = await makeCredential();
      expect((await send('DELETE', `/repo-credentials/${id}`)).status).toBe(200);
      expect(await credentialRow(id)).toBeUndefined();
      const rows = await auditRows('credential.delete');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetType: 'repo_credential', targetId: id });
    });
  },
);
