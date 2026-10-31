import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.REPO_CREDENTIALS_BACKING_EDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repo_credentials_backing_edit_test'))
  throw new Error(
    'Use a dedicated repo_credentials_backing_edit_test database for the backing credential edit tests',
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

import {
  decrypt,
  decryptDek,
  encrypt,
  encryptDek,
  generateDek,
  generateEncryptionKey,
  secretsService,
} from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type CredentialRow = typeof schema.repoCredentials.$inferSelect;
type ConnectionRow = typeof schema.integrationConnections.$inferSelect;
type ConnectionInsert = typeof schema.integrationConnections.$inferInsert;

const REFUSED_CODE = 'credential-backs-connection';
const LINK_GITHUB = '/integrations/providers/github/link-credential';
const LONG_AGO = new Date('2020-01-01T00:00:00Z');
const BLOCKED_WITHIN_MS = 10_000;
const LOCK_TEST_TIMEOUT = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('editing a Git credential a connection points at, on Postgres', () => {
  let db: Database;
  let app: ReturnType<typeof createApiApp>;
  let userId: string;
  let cookie: string;
  let kek: string;
  const userIds: string[] = [];

  const send = async (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const edit = (id: string, body: Record<string, unknown>) =>
    send('PUT', `/repo-credentials/${id}`, body);
  const link = (repoCredentialId: string) => send('POST', LINK_GITHUB, { repoCredentialId });

  const makeUser = async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: `${randomUUID()}@repo-credentials-backing-edit.test.local`,
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role: 'user',
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    return user!.id;
  };

  // The username and secret are really encrypted, so an edit that re-encrypts one can be decrypted.
  const makeCredential = async (over: Partial<typeof schema.repoCredentials.$inferInsert> = {}) => {
    const dek = generateDek();
    const [row] = await db
      .insert(schema.repoCredentials)
      .values({
        userId,
        label: 'before',
        host: 'github.com',
        usernameEncrypted: encrypt('old-user', dek),
        secretEncrypted: encrypt('old-secret', dek),
        encryptedDek: encryptDek(dek, kek),
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
    accountLabel: 'before',
    authMethod: 'token',
    repoCredentialId,
    updatedAt: LONG_AGO,
    ...over,
  });
  const makeConnection = async (repoCredentialId: string, over: Partial<ConnectionInsert> = {}) => {
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
    return row!;
  };
  const connectionRow = async (id: string) => {
    const [row] = await db
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, id));
    return row!;
  };
  const connectionsOfUser = () =>
    db
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.ownerUserId, userId));
  const auditRows = (action?: string) =>
    db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, userId))
      .then((rows) => (action === undefined ? rows : rows.filter((row) => row.action === action)));

  // A refused edit applies nothing: not the credential, not its connection, not an audit row.
  const expectRefused = async (
    res: Response,
    before: { credential: CredentialRow; connection: ConnectionRow },
  ) => {
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: REFUSED_CODE });
    expect(await credentialRow(before.credential.id)).toEqual(before.credential);
    expect(await connectionRow(before.connection.id)).toEqual(before.connection);
    expect(await auditRows('credential.update')).toEqual([]);
  };

  // A second transaction takes the credential row FOR UPDATE, waits for release(), then runs
  // `whileHeld` and commits; `committed` settles with whatever `whileHeld` returned.
  const holdCredentialLock = async <T>(credentialId: string, whileHeld: (tx: Tx) => Promise<T>) => {
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
      if (request.settled) throw new Error('the request ended without waiting for the lock holder');
      const [row] = await db.execute<{ blocked: number }>(sql`
        select count(*)::int as blocked from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and ${pid}::int = any (pg_blocking_pids(pid))`);
      if (row && row.blocked > 0) return;
      if (Date.now() > deadline) {
        throw new Error(`no request was blocked by the lock holder within ${BLOCKED_WITHIN_MS} ms`);
      }
      await sleep(20);
    }
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    app = createApiApp('http://localhost:3000');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    kek = generateEncryptionKey();
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(kek);
    userId = await makeUser();
    cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.actorUserId, userIds));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    userIds.length = 0;
  });

  describe('a host or forge change on a credential a connection backs', () => {
    it('E1 refuses a host change, even one that keeps the forge, and applies nothing', async () => {
      const credential = await makeCredential({ provider: 'github' });
      const connection = await makeConnection(credential.id);

      const res = await edit(credential.id, {
        label: 'renamed',
        host: 'ghe.example.com',
        provider: 'github',
      });

      await expectRefused(res, { credential, connection });
    });

    it('E2 refuses a provider change to another forge on the same host', async () => {
      const credential = await makeCredential();
      const connection = await makeConnection(credential.id);

      const res = await edit(credential.id, {
        label: 'renamed',
        host: 'github.com',
        provider: 'gitlab',
      });

      await expectRefused(res, { credential, connection });
    });

    it('E3 refuses blanking the provider when the host cannot name the forge', async () => {
      const credential = await makeCredential({ host: 'ghe.example.com', provider: 'github' });
      const connection = await makeConnection(credential.id);

      const res = await edit(credential.id, {
        label: 'renamed',
        host: 'ghe.example.com',
        provider: '',
      });

      await expectRefused(res, { credential, connection });
    });

    it('E4 reads a stored host and a typed one case-insensitively, and stores the typed one lower case', async () => {
      const credential = await makeCredential({ host: 'GitHub.com' });
      await makeConnection(credential.id);

      const res = await edit(credential.id, { label: 'before', host: 'GitHub.com ' });

      expect(res.status).toBe(200);
      expect((await credentialRow(credential.id)).host).toBe('github.com');
    });

    it('E5 lets the provider change while the forge stays the connection forge', async () => {
      const credential = await makeCredential();
      await makeConnection(credential.id);

      const pinned = await edit(credential.id, {
        label: 'before',
        host: 'github.com',
        provider: 'github',
      });
      expect(pinned.status).toBe(200);
      expect((await credentialRow(credential.id)).provider).toBe('github');

      const blanked = await edit(credential.id, {
        label: 'before',
        host: 'github.com',
        provider: '',
      });
      expect(blanked.status).toBe(200);
      expect((await credentialRow(credential.id)).provider).toBeNull();
    });

    it('E6 applies the label, username, secret, git identity and API base of a backing credential', async () => {
      const credential = await makeCredential();
      await makeConnection(credential.id);

      const res = await edit(credential.id, {
        label: 'renamed',
        host: 'github.com',
        username: 'new-user',
        secret: 'new-secret',
        gitName: 'New Name',
        gitEmail: 'new@example.com',
        apiBaseUrl: 'https://api.github.com',
      });

      expect(res.status).toBe(200);
      const row = await credentialRow(credential.id);
      expect(row).toMatchObject({
        label: 'renamed',
        host: 'github.com',
        gitName: 'New Name',
        gitEmail: 'new@example.com',
        apiBaseUrl: 'https://api.github.com',
      });
      const dek = decryptDek(row.encryptedDek, kek);
      expect(decrypt(row.usernameEncrypted, dek)).toBe('new-user');
      expect(decrypt(row.secretEncrypted, dek)).toBe('new-secret');
      expect(await auditRows('credential.update')).toHaveLength(1);
    });

    it('E7 changes the host and provider of a credential no connection backs, whatever else the caller has linked', async () => {
      const linked = await makeCredential();
      await makeConnection(linked.id);
      const plain = await makeCredential({ host: 'git.example.com', provider: 'gitea' });

      const moved = await edit(plain.id, {
        label: 'before',
        host: 'ghe.example.com',
        provider: 'github',
      });
      expect(moved.status).toBe(200);
      expect(await credentialRow(plain.id)).toMatchObject({
        host: 'ghe.example.com',
        provider: 'github',
      });

      const reforged = await edit(plain.id, {
        label: 'before',
        host: 'ghe.example.com',
        provider: 'gitlab',
      });
      expect(reforged.status).toBe(200);
      expect(await credentialRow(plain.id)).toMatchObject({
        host: 'ghe.example.com',
        provider: 'gitlab',
      });
    });

    // The credential's forge (gitea) already differs from its connection's (github).
    const makeDrifted = async () => {
      const credential = await makeCredential({ host: 'git.example.com', provider: 'gitea' });
      const connection = await makeConnection(credential.id);
      return { credential, connection };
    };

    it('E8a lets a credential whose forge drifted be edited back to its connection forge', async () => {
      const { credential } = await makeDrifted();

      const res = await edit(credential.id, {
        label: 'before',
        host: 'git.example.com',
        provider: 'github',
      });

      expect(res.status).toBe(200);
      expect(await credentialRow(credential.id)).toMatchObject({
        host: 'git.example.com',
        provider: 'github',
      });
    });

    it('E8b refuses moving a drifted credential to a forge that is still not its connection forge', async () => {
      const drifted = await makeDrifted();

      const res = await edit(drifted.credential.id, {
        label: 'before',
        host: 'git.example.com',
        provider: 'gitlab',
      });

      await expectRefused(res, drifted);
    });

    it('E8c refuses a host change on a drifted credential, even one that repairs the forge', async () => {
      const drifted = await makeDrifted();

      const res = await edit(drifted.credential.id, {
        label: 'before',
        host: 'git2.example.com',
        provider: 'github',
      });

      await expectRefused(res, drifted);
    });

    it('E8d lets a drifted credential keep its host and forge while another field changes', async () => {
      const { credential } = await makeDrifted();

      const res = await edit(credential.id, {
        label: 'renamed',
        host: 'git.example.com',
        provider: 'gitea',
      });

      expect(res.status).toBe(200);
      expect(await credentialRow(credential.id)).toMatchObject({
        label: 'renamed',
        host: 'git.example.com',
        provider: 'gitea',
      });
    });
  });

  describe('PUT /repo-credentials/:id takes the connection row before the credential row', () => {
    it(
      'E14 waits for a connection row someone else holds without holding the credential row',
      async () => {
        const credential = await makeCredential();
        const connection = await makeConnection(credential.id, { accountLabel: 'before' });
        const gate = Promise.withResolvers<void>();
        const taken = Promise.withResolvers<number>();
        // What a reconnect or a disconnect holds first.
        const holder = db.transaction(async (tx) => {
          await tx
            .select({ id: schema.integrationConnections.id })
            .from(schema.integrationConnections)
            .where(eq(schema.integrationConnections.id, connection.id))
            .for('update');
          const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
          taken.resolve(backend!.pid);
          await gate.promise;
        });
        const pid = await taken.promise;
        const request = track(edit(credential.id, { label: 'after', host: 'github.com' }));
        let credentialFree: unknown[] = [];
        try {
          await waitUntilBlockedBy(pid, request);
          await sleep(300);
          expect(request.settled).toBe(false);
          // A delete or a reconnect takes the connection first and then the credential; an edit that
          // held the credential while it waited for the connection would deadlock with it.
          credentialFree = [
            ...(await db.transaction((tx) =>
              tx.execute(
                sql`select id from repo_credentials where id = ${credential.id} for update nowait`,
              ),
            )),
          ];
        } finally {
          gate.resolve();
          await Promise.allSettled([holder, request.response]);
        }

        const res = await request.response;

        expect(credentialFree).toHaveLength(1);
        expect(res.status).toBe(200);
        expect((await credentialRow(credential.id)).label).toBe('after');
        expect((await connectionRow(connection.id)).accountLabel).toBe('after');
      },
      LOCK_TEST_TIMEOUT,
    );
  });

  describe('a credential the user takes over', () => {
    it('E13 drops the sign-in marker when the secret is replaced, and keeps it for any other edit', async () => {
      const credential = await makeCredential({ signInAccountId: '4242' });

      const renamed = await edit(credential.id, { label: 'renamed', host: 'github.com' });
      expect(renamed.status).toBe(200);
      expect((await credentialRow(credential.id)).signInAccountId).toBe('4242');

      const replaced = await edit(credential.id, {
        label: 'renamed',
        host: 'github.com',
        secret: 'my-own-token',
      });
      expect(replaced.status).toBe(200);
      expect((await credentialRow(credential.id)).signInAccountId).toBeNull();
    });
  });

  describe('the connection label follows the credential label', () => {
    it('E9a renames a token connection with its credential and advances its updated_at', async () => {
      const credential = await makeCredential();
      const connection = await makeConnection(credential.id, { accountLabel: 'before' });

      const res = await edit(credential.id, { label: 'after', host: 'github.com' });

      expect(res.status).toBe(200);
      expect((await credentialRow(credential.id)).label).toBe('after');
      const synced = await connectionRow(connection.id);
      expect(synced.accountLabel).toBe('after');
      expect(synced.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
    });

    it.each(['device', 'oauth2'])(
      'E9b leaves the account name of a sign-in connection (%s) alone when its credential is renamed',
      async (authMethod) => {
        const credential = await makeCredential({ label: 'GitHub sign-in (octocat)' });
        const connection = await makeConnection(credential.id, {
          accountLabel: 'octocat',
          externalAccountId: `octocat-${randomUUID()}`,
          authMethod,
        });

        const res = await edit(credential.id, { label: 'My work account', host: 'github.com' });

        expect(res.status).toBe(200);
        expect((await credentialRow(credential.id)).label).toBe('My work account');
        expect(await connectionRow(connection.id)).toMatchObject({
          accountLabel: 'octocat',
          externalAccountId: connection.externalAccountId,
        });
      },
    );

    it('E9c leaves a token connection untouched when an edit keeps the label', async () => {
      const credential = await makeCredential();
      const connection = await makeConnection(credential.id, { accountLabel: 'before' });

      const res = await edit(credential.id, {
        label: 'before',
        host: 'github.com',
        gitName: 'New Name',
        gitEmail: 'new@example.com',
      });

      expect(res.status).toBe(200);
      expect((await credentialRow(credential.id)).gitName).toBe('New Name');
      expect(await connectionRow(connection.id)).toEqual(connection);
    });
  });

  describe('POST /integrations/providers/github/link-credential reads the credential under its row lock', () => {
    it(
      'E10 judges the credential as an edit committed while the link waited left it',
      async () => {
        const credential = await makeCredential();
        const lock = await holdCredentialLock(credential.id, (tx) =>
          tx
            .update(schema.repoCredentials)
            .set({ provider: 'gitea', host: 'git.example.com' })
            .where(eq(schema.repoCredentials.id, credential.id)),
        );
        const request = track(link(credential.id));
        try {
          await waitUntilBlockedBy(lock.pid, request);
          await sleep(300);
          expect(request.settled).toBe(false);
        } finally {
          lock.release();
          await Promise.allSettled([lock.committed, request.response]);
        }

        const res = await request.response;

        expect(res.status).toBe(400);
        expect(await connectionsOfUser()).toEqual([]);
        expect(await auditRows()).toEqual([]);
      },
      LOCK_TEST_TIMEOUT,
    );

    it('E11 refuses to link a credential an earlier edit moved to another forge', async () => {
      const credential = await makeCredential();
      const moved = await edit(credential.id, {
        label: 'before',
        host: 'git.example.com',
        provider: 'gitea',
      });
      expect(moved.status).toBe(200);

      const res = await link(credential.id);

      expect(res.status).toBe(400);
      expect(await connectionsOfUser()).toEqual([]);
      expect(await auditRows('integration.connection.create')).toEqual([]);
    });
  });

  describe('PUT /repo-credentials/:id looks the connection up under the credential row lock', () => {
    it(
      'E12 sees a connection linked while the edit waited, and refuses the host change',
      async () => {
        const credential = await makeCredential({ provider: 'github' });
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
        const request = track(
          edit(credential.id, { label: 'renamed', host: 'ghe.example.com', provider: 'github' }),
        );
        try {
          await waitUntilBlockedBy(lock.pid, request);
          await sleep(300);
          expect(request.settled).toBe(false);
        } finally {
          lock.release();
          await Promise.allSettled([lock.committed, request.response]);
        }

        const connection = await lock.committed;
        const res = await request.response;

        await expectRefused(res, { credential, connection });
      },
      LOCK_TEST_TIMEOUT,
    );
  });
});
