import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.REPO_CREDENTIALS_DELETE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repo_credentials_delete_test'))
  throw new Error(
    'Use a dedicated repo_credentials_delete_test database for the credential delete tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'fatal';
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

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ConnectionInsert = typeof schema.integrationConnections.$inferInsert;
type ListedCredential = { id: string; connection?: unknown };

const BLOCKED_WITHIN_MS = 10_000;
const LOCK_TEST_TIMEOUT = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  'listing and deleting a Git credential a connection points at, on Postgres',
  () => {
    let db: Database;
    let app: ReturnType<typeof createApiApp>;
    let userId: string;
    let cookie: string;
    const userIds: string[] = [];

    const send = async (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const remove = (id: string) => send('DELETE', `/repo-credentials/${id}`);
    const list = async () => {
      const res = await send('GET', '/repo-credentials');
      expect(res.status).toBe(200);
      return ((await res.json()) as { credentials: ListedCredential[] }).credentials;
    };

    const makeUser = async () => {
      const [user] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: `${randomUUID()}@repo-credentials-delete.test.local`,
          emailBlindIndex: randomBytes(16).toString('hex'),
          passwordHash: 'not-a-real-hash',
          role: 'user',
        })
        .returning({ id: schema.users.id });
      userIds.push(user!.id);
      return user!.id;
    };

    // Every string a leaked audit row could carry is distinctive, so a leak cannot hide in a shared word.
    const makeCredential = async (
      over: Partial<typeof schema.repoCredentials.$inferInsert> = {},
    ) => {
      const [row] = await db
        .insert(schema.repoCredentials)
        .values({
          userId,
          label: `label-${randomUUID()}`,
          host: 'github.com',
          usernameEncrypted: `username-${randomUUID()}`,
          secretEncrypted: `secret-${randomUUID()}`,
          encryptedDek: `dek-${randomUUID()}`,
          ...over,
        })
        .returning();
      return row!;
    };

    const connectionValues = (
      repoCredentialId: string,
      over: Partial<ConnectionInsert> = {},
    ): ConnectionInsert => ({
      providerId: 'github',
      scope: 'user',
      ownerUserId: userId,
      accountLabel: `account-${randomUUID()}`,
      authMethod: 'token',
      repoCredentialId,
      ...over,
    });
    const makeConnection = async (
      repoCredentialId: string,
      over: Partial<ConnectionInsert> = {},
    ) => {
      const [row] = await db
        .insert(schema.integrationConnections)
        .values(connectionValues(repoCredentialId, over))
        .returning();
      return row!;
    };

    const credentialRow = async (id: string) => {
      const [row] = await db
        .select()
        .from(schema.repoCredentials)
        .where(eq(schema.repoCredentials.id, id));
      return row;
    };
    const connectionRow = async (id: string) => {
      const [row] = await db
        .select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, id));
      return row;
    };
    const auditRows = (actor = userId) =>
      db.select().from(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, actor));

    // A second transaction takes the credential row FOR UPDATE, waits for release(), then runs
    // `whileHeld` and commits; `committed` settles with whatever `whileHeld` returned.
    const holdCredentialLock = async <T>(
      credentialId: string,
      whileHeld: (tx: Tx) => Promise<T>,
    ) => {
      const gate = Promise.withResolvers<void>();
      const taken = Promise.withResolvers<number>();
      const committed = db.transaction(async (tx) => {
        await tx
          .select({ id: schema.repoCredentials.id })
          .from(schema.repoCredentials)
          .where(eq(schema.repoCredentials.id, credentialId))
          .for('update');
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        taken.resolve(backend!.pid);
        await gate.promise;
        return whileHeld(tx);
      });
      const pid = await Promise.race([
        taken.promise,
        committed.then(() => {
          throw new Error('the lock holder ended before it held the credential row');
        }),
      ]);
      return { pid, committed, release: () => gate.resolve() };
    };

    const track = (response: Promise<Response>) => {
      const request = { settled: false, response };
      const mark = () => {
        request.settled = true;
      };
      void response.then(mark, mark);
      return request;
    };

    // True evidence the request waits on the holder: a backend blocked by the holder's pid.
    const waitUntilBlockedBy = async (pid: number, request: { settled: boolean }) => {
      const deadline = Date.now() + BLOCKED_WITHIN_MS;
      for (;;) {
        if (request.settled)
          throw new Error('the request ended without waiting for the lock holder');
        const [row] = await db.execute<{ blocked: number }>(sql`
          select count(*)::int as blocked from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and ${pid}::int = any (pg_blocking_pids(pid))`);
        if (row && row.blocked > 0) return;
        if (Date.now() > deadline) {
          throw new Error(
            `no request was blocked by the lock holder within ${BLOCKED_WITHIN_MS} ms`,
          );
        }
        await sleep(20);
      }
    };

    beforeAll(async () => {
      db = createDatabase(url as string);
      h.db = db;
      app = createApiApp('http://localhost:3000');
      // A run killed inside D3 leaves the refusing trigger behind, and it would fail every audit insert.
      const [leftover] = await db.execute(
        sql`select 1 from pg_trigger where tgname = 'refuse_audit_insert'`,
      );
      if (leftover) await allowAuditInserts(db);
    });

    afterAll(async () => {
      await db.$client.end({ timeout: 5 });
    });

    beforeEach(async () => {
      vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
      vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(generateEncryptionKey());
      userId = await makeUser();
      cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.actorUserId, userIds));
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
      userIds.length = 0;
    });

    describe('GET /repo-credentials', () => {
      it('L1 lists a credential no connection backs with connection null', async () => {
        const credential = await makeCredential();

        const rows = await list();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: credential.id, connection: null });
      });

      it("L2 lists the connection that backs a credential, and never another user's", async () => {
        const backing = await makeCredential();
        const plain = await makeCredential();
        const connection = await makeConnection(backing.id, { accountLabel: 'octocat-L2' });
        const other = await makeUser();
        const theirs = await makeCredential({ userId: other });
        await makeConnection(theirs.id, { ownerUserId: other });
        // Rows that only look like mine: a connection another user owns, and one that is shared.
        const foreignOwned = await makeCredential();
        await makeConnection(foreignOwned.id, { ownerUserId: other });
        const sharedScope = await makeCredential();
        await makeConnection(sharedScope.id, { scope: 'shared' });

        const rows = await list();

        const byId = new Map(rows.map((row) => [row.id, row]));
        expect([...byId.keys()].sort()).toEqual(
          [backing.id, plain.id, foreignOwned.id, sharedScope.id].sort(),
        );
        expect(byId.get(backing.id)!.connection).toEqual({
          id: connection.id,
          providerId: 'github',
          providerName: 'GitHub',
          accountLabel: 'octocat-L2',
        });
        expect(byId.get(plain.id)!.connection).toBeNull();
        expect(byId.get(foreignOwned.id)!.connection).toBeNull();
        expect(byId.get(sharedScope.id)!.connection).toBeNull();
      });
    });

    describe('DELETE /repo-credentials/:id', () => {
      it('D1 names the connection a deleted credential backed, and nothing else, in its audit row', async () => {
        const credential = await makeCredential();
        const connection = await makeConnection(credential.id);

        const res = await remove(credential.id);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(await credentialRow(credential.id)).toBeUndefined();
        expect(await connectionRow(connection.id)).toBeUndefined();
        const rows = await auditRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'credential.delete',
          targetType: 'repo_credential',
          targetId: credential.id,
        });
        expect(rows[0]!.metadata).toEqual({ connectionId: connection.id, providerId: 'github' });
        const json = JSON.stringify(rows);
        for (const secret of [
          credential.label,
          credential.host,
          credential.usernameEncrypted,
          credential.secretEncrypted,
          credential.encryptedDek,
          connection.accountLabel,
        ]) {
          expect(json).not.toContain(secret);
        }
      });

      it("D2 leaves both connection keys out of the audit row when none backs the credential, and spares the caller's other connection", async () => {
        const credential = await makeCredential();
        const bystander = await makeCredential();
        const bystanderConnection = await makeConnection(bystander.id);

        const res = await remove(credential.id);

        expect(res.status).toBe(200);
        expect(await credentialRow(credential.id)).toBeUndefined();
        expect(await connectionRow(bystanderConnection.id)).toBeDefined();
        const rows = await auditRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: 'credential.delete', targetId: credential.id });
        expect(rows[0]!.metadata ?? {}).not.toHaveProperty('connectionId');
        expect(rows[0]!.metadata ?? {}).not.toHaveProperty('providerId');
      });

      it('D3 keeps the credential and its connection when the audit row cannot be written', async () => {
        const credential = await makeCredential();
        const connection = await makeConnection(credential.id);
        await refuseAuditInserts(db);
        let res: Response;
        try {
          res = await remove(credential.id);
        } finally {
          await allowAuditInserts(db);
        }

        expect(res.status).toBe(500);
        expect(await credentialRow(credential.id)).toEqual(credential);
        expect(await connectionRow(connection.id)).toEqual(connection);
        expect(await auditRows()).toEqual([]);
      });

      it(
        'D4 looks the connection up after it holds the credential row, so one created while the delete waited is named',
        async () => {
          const credential = await makeCredential();
          const lock = await holdCredentialLock(
            credential.id,
            async (tx) =>
              (
                await tx
                  .insert(schema.integrationConnections)
                  .values(connectionValues(credential.id))
                  .returning()
              )[0]!,
          );
          const request = track(remove(credential.id));
          try {
            await waitUntilBlockedBy(lock.pid, request);
            await sleep(300);
            expect(request.settled).toBe(false);
          } finally {
            lock.release();
            await Promise.allSettled([lock.committed, request.response]);
          }

          const late = await lock.committed;
          const res = await request.response;

          expect(res.status).toBe(200);
          expect(await credentialRow(credential.id)).toBeUndefined();
          expect(await connectionRow(late.id)).toBeUndefined();
          const rows = await auditRows();
          expect(rows).toHaveLength(1);
          expect(rows[0]!.metadata).toEqual({ connectionId: late.id, providerId: 'github' });
        },
        LOCK_TEST_TIMEOUT,
      );

      it("D5 answers 404 for another user's credential and for one that does not exist, and writes no audit row", async () => {
        const other = await makeUser();
        const foreign = await makeCredential({ userId: other });
        const foreignConnection = await makeConnection(foreign.id, { ownerUserId: other });

        for (const id of [foreign.id, randomUUID()]) {
          expect((await remove(id)).status).toBe(404);
        }

        expect(await auditRows()).toEqual([]);
        expect(await auditRows(other)).toEqual([]);
        expect(await credentialRow(foreign.id)).toEqual(foreign);
        expect(await connectionRow(foreignConnection.id)).toEqual(foreignConnection);
      });
    });
  },
);
