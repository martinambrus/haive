import { randomBytes, randomUUID } from 'node:crypto';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, hasPgCode, schema, type Database } from '@haive/database';

const url = process.env.INTEGRATION_SIGN_IN_REUSE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integration_sign_in_reuse_test'))
  throw new Error(
    'Use a dedicated integration_sign_in_reuse_test database for the integration sign-in reuse tests',
  );

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'fatal';
});

import {
  decrypt,
  decryptDek,
  encrypt,
  encryptDek,
  generateDek,
  secretsService,
} from '@haive/shared';
import { getIntegrationProvider, type ResolvedOauthClient } from '@haive/shared/integrations';
import { disconnectConnection, linkCredential } from '../src/lib/integration-connections.js';
import { deviceMethodOf } from '../src/lib/integration-provider.js';
import { finishSignIn, type SignInResult } from '../src/lib/integration-sign-in.js';

const KEK = 'ab'.repeat(32);
const GITHUB_USER_URL = 'https://api.github.com/user';
const CLIENT: ResolvedOauthClient = {
  clientId: 'device-client',
  clientSecret: null,
  source: 'env',
};
/** The account behind an access token: 'tok-a', 'tok-a-2' and so on are octo; 'tok-b...' are hubot. */
const ACCOUNTS = [
  { tokenPrefix: 'tok-a', id: 4242, login: 'octo' },
  { tokenPrefix: 'tok-b', id: 777, login: 'hubot' },
];
const OCTO = '4242';
/** The SQLSTATE of the refusing trigger's own RAISE EXCEPTION. */
const RAISE_EXCEPTION = 'P0001';
const CREATE = 'integration.connection.create';
const RECONNECT = 'integration.connection.reconnect';

type CredentialRow = typeof schema.repoCredentials.$inferSelect;
type CredentialEdit = Partial<typeof schema.repoCredentials.$inferInsert>;

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

const github = required(getIntegrationProvider('github'), 'the github provider spec');
const device = required(deviceMethodOf(github), "the github spec's device method");

const secretOf = (row: CredentialRow) =>
  decrypt(row.secretEncrypted, decryptDek(row.encryptedDek, KEK));
const usernameOf = (row: CredentialRow) =>
  decrypt(row.usernameEncrypted, decryptDek(row.encryptedDek, KEK));
const credentialIdOf = (result: SignInResult) =>
  required(result.credential, 'the credential of a forge sign-in').id;

/** Only the github user endpoint is stubbed; anything else answers 404 and no vendor is ever called. */
const githubUserEndpoint = async (input: string | URL | Request, init?: RequestInit) => {
  const target = String(input instanceof Request ? input.url : input);
  if (target !== GITHUB_USER_URL) return new Response('not stubbed', { status: 404 });
  const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
  const account = ACCOUNTS.find((candidate) => token.startsWith(candidate.tokenPrefix));
  return account
    ? Response.json({ id: account.id, login: account.login })
    : Response.json({ message: 'Bad credentials' }, { status: 401 });
};

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
  'a forge sign-in takes back the Git credential a disconnect left behind, on Postgres',
  () => {
    let db: Database;
    let userIds: string[] = [];

    const makeUser = async () => {
      const [row] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: `${randomUUID()}@integration-sign-in-reuse.test.local`,
          emailBlindIndex: randomBytes(16).toString('hex'),
          passwordHash: 'not-a-real-hash',
          role: 'user',
        })
        .returning({ id: schema.users.id });
      const id = required(row, 'the new user').id;
      userIds.push(id);
      return id;
    };

    const signIn = (userId: string, accessToken: string) =>
      finishSignIn({
        db,
        userId,
        spec: github,
        method: device,
        client: CLIENT,
        tokens: { accessToken, refreshToken: null, expiresAt: null, scopes: ['repo'] },
        requestedScopes: ['repo'],
      });

    const credentialsOf = (userId: string) =>
      db
        .select()
        .from(schema.repoCredentials)
        .where(eq(schema.repoCredentials.userId, userId))
        .orderBy(asc(schema.repoCredentials.createdAt));
    const credentialById = async (id: string) => {
      const [row] = await db
        .select()
        .from(schema.repoCredentials)
        .where(eq(schema.repoCredentials.id, id));
      return required(row, `credential ${id}`);
    };
    const connectionsOf = (userId: string) =>
      db
        .select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.ownerUserId, userId))
        .orderBy(asc(schema.integrationConnections.createdAt));
    const auditOf = (userId: string) =>
      db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.actorUserId, userId))
        .orderBy(asc(schema.auditEvents.createdAt));
    const auditCount = async (userId: string, action: string) =>
      (await auditOf(userId)).filter((row) => row.action === action).length;
    const editCredential = (id: string, changes: CredentialEdit) =>
      db.update(schema.repoCredentials).set(changes).where(eq(schema.repoCredentials.id, id));

    /** A credential typed by hand: really encrypted (the username is octo), never made by a sign-in. */
    const typeCredential = async (userId: string, provider: string | null) => {
      const dek = generateDek();
      const [row] = await db
        .insert(schema.repoCredentials)
        .values({
          userId,
          label: 'GitHub OAuth (octo)',
          host: 'github.com',
          provider,
          usernameEncrypted: encrypt('octo', dek),
          secretEncrypted: encrypt('typed-secret', dek),
          encryptedDek: encryptDek(dek, KEK),
        })
        .returning();
      return required(row, 'the typed credential');
    };

    // The refusing trigger lives on the shared audit_events table: it is dropped as soon as a test is
    // done with it, and only then, since a DROP of a missing trigger makes the driver print a notice.
    let auditRefused = false;
    const refuseAudit = async () => {
      auditRefused = true;
      await refuseAuditInserts(db);
    };
    const allowAudit = async () => {
      await allowAuditInserts(db);
      auditRefused = false;
    };

    beforeAll(async () => {
      db = createDatabase(url as string);
      const leftover = await db.execute(
        sql`select 1 from pg_trigger where tgname = 'refuse_audit_insert'`,
      );
      if (leftover.length > 0) await allowAuditInserts(db);
    });

    afterAll(async () => {
      await db.$client.end({ timeout: 5 });
    });

    beforeEach(() => {
      vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
      vi.stubGlobal('fetch', vi.fn(githubUserEndpoint));
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      if (auditRefused) await allowAudit();
      const ids = userIds;
      userIds = [];
      if (ids.length === 0) return;
      await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.actorUserId, ids));
      await db
        .delete(schema.integrationConnections)
        .where(inArray(schema.integrationConnections.ownerUserId, ids));
      await db.delete(schema.repoCredentials).where(inArray(schema.repoCredentials.userId, ids));
      await db.delete(schema.users).where(inArray(schema.users.id, ids));
    });

    it("R0 a forge sign-in records the vendor's account id on the credential it makes", async () => {
      const user = await makeUser();
      const result = await signIn(user, 'tok-a');
      expect((await credentialById(credentialIdOf(result))).signInAccountId).toBe(OCTO);
    });

    it('R1 sign in, disconnect, sign in again: the same credential comes back with the new token', async () => {
      const user = await makeUser();
      const first = await signIn(user, 'tok-a');
      const credentialId = credentialIdOf(first);
      await disconnectConnection(db, user, first.connection.id);
      expect(await connectionsOf(user)).toEqual([]);
      expect(await credentialsOf(user)).toHaveLength(1);
      await editCredential(credentialId, { label: 'My work GitHub' });

      const second = await signIn(user, 'tok-a-2');

      const credentials = await credentialsOf(user);
      expect(credentials).toHaveLength(1);
      const credential = required(credentials[0], 'the credential');
      expect(credential.id).toBe(credentialId);
      expect(secretOf(credential)).toBe('tok-a-2');
      expect(usernameOf(credential)).toBe('octo');
      expect(credential).toMatchObject({
        label: 'My work GitHub',
        host: 'github.com',
        provider: 'github',
      });
      expect(second.credential).toMatchObject({
        id: credentialId,
        label: 'My work GitHub',
        host: 'github.com',
      });
      expect(await connectionsOf(user)).toMatchObject([
        { id: second.connection.id, repoCredentialId: credentialId, externalAccountId: OCTO },
      ]);
      expect(credential.signInAccountId).toBe(OCTO);
    });

    it("R2 two accounts on one host: a sign-in takes back its own account's credential only", async () => {
      const user = await makeUser();
      const octo = await signIn(user, 'tok-a');
      const hubot = await signIn(user, 'tok-b');
      const octoId = credentialIdOf(octo);
      const hubotId = credentialIdOf(hubot);
      expect(await credentialsOf(user)).toHaveLength(2);
      await disconnectConnection(db, user, octo.connection.id);
      await disconnectConnection(db, user, hubot.connection.id);
      const octoBefore = await credentialById(octoId);

      const hubotAgain = await signIn(user, 'tok-b-2');

      expect(await credentialsOf(user)).toHaveLength(2);
      expect(credentialIdOf(hubotAgain)).toBe(hubotId);
      expect(secretOf(await credentialById(hubotId))).toBe('tok-b-2');
      expect(await credentialById(octoId)).toEqual(octoBefore);

      // The other way round, so that neither the oldest nor the newest orphan passes by luck.
      await disconnectConnection(db, user, hubotAgain.connection.id);
      const hubotBefore = await credentialById(hubotId);

      const octoAgain = await signIn(user, 'tok-a-2');

      expect(await credentialsOf(user)).toHaveLength(2);
      expect(credentialIdOf(octoAgain)).toBe(octoId);
      expect(secretOf(await credentialById(octoId))).toBe('tok-a-2');
      expect(await credentialById(hubotId)).toEqual(hubotBefore);
    });

    it.each([{ provider: null }, { provider: 'github' }])(
      'R3 a hand-typed credential (provider $provider) is never taken: the sign-in makes its own',
      async ({ provider }) => {
        const user = await makeUser();
        const typed = await typeCredential(user, provider);

        const result = await signIn(user, 'tok-a');

        expect(await credentialById(typed.id)).toEqual(typed);
        expect(secretOf(typed)).toBe('typed-secret');
        expect(await credentialsOf(user)).toHaveLength(2);
        expect(credentialIdOf(result)).not.toBe(typed.id);
        const made = await credentialById(credentialIdOf(result));
        expect(secretOf(made)).toBe('tok-a');
        expect(await connectionsOf(user)).toMatchObject([
          { id: result.connection.id, repoCredentialId: made.id },
        ]);
        expect(made.signInAccountId).toBe(OCTO);
        expect(typed.signInAccountId).toBeNull();
      },
    );

    it('R4 an orphan that a token connection now links is not taken: a second credential is made', async () => {
      const user = await makeUser();
      const first = await signIn(user, 'tok-a');
      const orphanId = credentialIdOf(first);
      await disconnectConnection(db, user, first.connection.id);
      const linked = await linkCredential(db, user, github, orphanId);
      expect(linked).toMatchObject({ authMethod: 'token', repoCredentialId: orphanId });
      const orphanBefore = await credentialById(orphanId);

      const again = await signIn(user, 'tok-a-2');

      expect(await credentialsOf(user)).toHaveLength(2);
      expect(credentialIdOf(again)).not.toBe(orphanId);
      expect(await credentialById(orphanId)).toEqual(orphanBefore);
      const pointers = Object.fromEntries(
        (await connectionsOf(user)).map((connection) => [
          connection.id,
          connection.repoCredentialId,
        ]),
      );
      expect(pointers).toEqual({
        [linked.id]: orphanId,
        [again.connection.id]: credentialIdOf(again),
      });
    });

    const drifts: Array<{ changed: string; edit: CredentialEdit }> = [
      { changed: 'host', edit: { host: 'git.example.com' } },
      { changed: 'provider', edit: { provider: 'gitea' } },
    ];

    it.each(drifts)(
      'R5 an orphan whose $changed was changed meanwhile is left alone: the sign-in makes a new credential',
      async ({ edit }) => {
        const user = await makeUser();
        const first = await signIn(user, 'tok-a');
        const orphanId = credentialIdOf(first);
        await disconnectConnection(db, user, first.connection.id);
        await editCredential(orphanId, edit);
        const orphanBefore = await credentialById(orphanId);

        const again = await signIn(user, 'tok-a-2');

        expect(await credentialsOf(user)).toHaveLength(2);
        expect(credentialIdOf(again)).not.toBe(orphanId);
        expect(await credentialById(orphanId)).toEqual(orphanBefore);
        expect(secretOf(orphanBefore)).toBe('tok-a');
        const made = await credentialById(credentialIdOf(again));
        expect(made).toMatchObject({ host: 'github.com', provider: 'github' });
        expect(secretOf(made)).toBe('tok-a-2');
        expect(await connectionsOf(user)).toMatchObject([
          { id: again.connection.id, repoCredentialId: made.id },
        ]);
      },
    );

    it("R5c an orphan whose provider was cleared is still the provider's forge on its host: it is taken back as it is", async () => {
      const user = await makeUser();
      const first = await signIn(user, 'tok-a');
      const orphanId = credentialIdOf(first);
      await disconnectConnection(db, user, first.connection.id);
      await editCredential(orphanId, { provider: null });

      const again = await signIn(user, 'tok-a-2');

      expect(await credentialsOf(user)).toHaveLength(1);
      expect(credentialIdOf(again)).toBe(orphanId);
      const credential = await credentialById(orphanId);
      expect(secretOf(credential)).toBe('tok-a-2');
      expect(credential).toMatchObject({ host: 'github.com', provider: null });
    });

    it('R11 an orphan stored under a replaced key is left alone: the sign-in makes its own instead of failing', async () => {
      const user = await makeUser();
      const first = await signIn(user, 'tok-a');
      const orphanId = credentialIdOf(first);
      await disconnectConnection(db, user, first.connection.id);
      await editCredential(orphanId, { encryptedDek: encryptDek(generateDek(), 'cd'.repeat(32)) });
      const orphanBefore = await credentialById(orphanId);

      const again = await signIn(user, 'tok-a-2');

      expect(await credentialsOf(user)).toHaveLength(2);
      expect(credentialIdOf(again)).not.toBe(orphanId);
      expect(await credentialById(orphanId)).toEqual(orphanBefore);
      const made = await credentialById(credentialIdOf(again));
      expect(secretOf(made)).toBe('tok-a-2');
      expect(await connectionsOf(user)).toMatchObject([
        { id: again.connection.id, repoCredentialId: made.id },
      ]);
    });

    it('R13 an orphan whose host was stored in other case is still on the sign-in host: it is taken back', async () => {
      const user = await makeUser();
      const first = await signIn(user, 'tok-a');
      const orphanId = credentialIdOf(first);
      await disconnectConnection(db, user, first.connection.id);
      await editCredential(orphanId, { host: 'GitHub.com' });

      const again = await signIn(user, 'tok-a-2');

      expect(await credentialsOf(user)).toHaveLength(1);
      expect(credentialIdOf(again)).toBe(orphanId);
      expect(secretOf(await credentialById(orphanId))).toBe('tok-a-2');
    });

    const reconnectDrifts: Array<{ drift: string; edit: CredentialEdit }> = [
      { drift: 'host', edit: { host: 'ghe.example.com', provider: 'github' } },
      { drift: 'provider', edit: { host: 'github.com', provider: 'gitea' } },
    ];

    it.each(reconnectDrifts)(
      'R6 a reconnect into a credential whose $drift drifted does not write it: a new one is made and the connection moves',
      async ({ edit }) => {
        const user = await makeUser();
        const first = await signIn(user, 'tok-a');
        const driftedId = credentialIdOf(first);
        await editCredential(driftedId, edit);
        const driftedBefore = await credentialById(driftedId);

        const again = await signIn(user, 'tok-a-2');

        const drifted = await credentialById(driftedId);
        expect(secretOf(drifted)).toBe('tok-a');
        expect(drifted).toEqual(driftedBefore);
        expect(await credentialsOf(user)).toHaveLength(2);
        const madeId = credentialIdOf(again);
        expect(madeId).not.toBe(driftedId);
        const made = await credentialById(madeId);
        expect(secretOf(made)).toBe('tok-a-2');
        expect(made).toMatchObject({
          host: 'github.com',
          provider: 'github',
          signInAccountId: OCTO,
        });
        expect(await connectionsOf(user)).toMatchObject([
          { id: first.connection.id, repoCredentialId: madeId },
        ]);
        expect(await auditCount(user, CREATE)).toBe(1);
        expect(await auditCount(user, RECONNECT)).toBe(1);
      },
    );

    it('R7 a plain reconnect refreshes the same credential in place', async () => {
      const user = await makeUser();
      const first = await signIn(user, 'tok-a');

      const again = await signIn(user, 'tok-a-2');

      expect(credentialIdOf(again)).toBe(credentialIdOf(first));
      expect(again.connection.id).toBe(first.connection.id);
      const credentials = await credentialsOf(user);
      expect(credentials).toHaveLength(1);
      expect(secretOf(required(credentials[0], 'the credential'))).toBe('tok-a-2');
      expect(await connectionsOf(user)).toHaveLength(1);
      expect(await auditCount(user, CREATE)).toBe(1);
      expect(await auditCount(user, RECONNECT)).toBe(1);
    });

    it("R8 another user signing in as the same account never touches the first user's credential", async () => {
      const owner = await makeUser();
      const other = await makeUser();
      const first = await signIn(owner, 'tok-a');
      const ownerCredentialId = credentialIdOf(first);
      await disconnectConnection(db, owner, first.connection.id);
      const ownerBefore = await credentialById(ownerCredentialId);

      const theirs = await signIn(other, 'tok-a-2');

      expect(credentialIdOf(theirs)).not.toBe(ownerCredentialId);
      expect(await credentialById(ownerCredentialId)).toEqual(ownerBefore);
      expect(await credentialsOf(owner)).toHaveLength(1);
      const made = await credentialsOf(other);
      expect(made).toHaveLength(1);
      const credential = required(made[0], 'the other user credential');
      expect(credential.id).toBe(credentialIdOf(theirs));
      expect(secretOf(credential)).toBe('tok-a-2');
    });

    it('R9 the audit metadata of a create and a reconnect keeps exactly its five keys', async () => {
      const user = await makeUser();
      const created = await signIn(user, 'tok-a');
      const reconnected = await signIn(user, 'tok-a-2');
      await disconnectConnection(db, user, reconnected.connection.id);
      const afterDisconnect = await signIn(user, 'tok-a-3');

      const metadata = (result: SignInResult) => ({
        providerId: 'github',
        authMethod: 'device',
        clientSource: 'env',
        credentialBacked: true,
        repoCredentialId: credentialIdOf(result),
      });
      const rows = (await auditOf(user)).filter(
        (row) => row.action === CREATE || row.action === RECONNECT,
      );
      expect(rows.map((row) => [row.action, row.metadata])).toEqual([
        [CREATE, metadata(created)],
        [RECONNECT, metadata(reconnected)],
        [CREATE, metadata(afterDisconnect)],
      ]);
    });

    it('R10 a refused audit row during the sign-in after a disconnect rolls everything back', async () => {
      const user = await makeUser();
      const first = await signIn(user, 'tok-a');
      const orphanId = credentialIdOf(first);
      await disconnectConnection(db, user, first.connection.id);
      const credentialsBefore = await credentialsOf(user);
      expect(secretOf(await credentialById(orphanId))).toBe('tok-a');
      expect(await connectionsOf(user)).toEqual([]);

      await refuseAudit();
      const failure = await signIn(user, 'tok-a-2').then(
        () => null,
        (err: unknown) => err,
      );
      await allowAudit();

      expect(hasPgCode(failure, RAISE_EXCEPTION)).toBe(true);
      expect(await credentialsOf(user)).toEqual(credentialsBefore);
      expect(secretOf(await credentialById(orphanId))).toBe('tok-a');
      expect(await connectionsOf(user)).toEqual([]);
    });
  },
);
