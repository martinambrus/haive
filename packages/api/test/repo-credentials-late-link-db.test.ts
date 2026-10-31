import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, hasPgCode, schema, type Database } from '@haive/database';

const url = process.env.REPO_CREDENTIALS_LATE_LINK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repo_credentials_late_link_test'))
  throw new Error(
    'Use a dedicated repo_credentials_late_link_test database for the late-linked connection tests',
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
import { getIntegrationProvider, type ResolvedOauthClient } from '@haive/shared/integrations';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';
import { deviceMethodOf } from '../src/lib/integration-provider.js';
import { finishSignIn } from '../src/lib/integration-sign-in.js';

// A delete or an edit of a Git credential locks the connection row that points at it, then the
// credential row: the order of a sign-in, which locks the account's connection and then the
// credential it writes. It looks the connection up again once it holds the credential row, because
// a link can commit while it waits for that row. Waiting for that late row with the credential held
// is the reverse of the sign-in's order, and a second sign-in of the account that holds the row and
// queues for the credential deadlocks with it (40P01). The late lookup therefore never waits: a row
// someone holds answers 503, and the request can be sent again.
//
// Every case runs the same interleave. A gate holds the credential row FOR NO KEY UPDATE, which the
// KEY SHARE of an insert's foreign key does not wait for, so the request finds no connection and
// waits at the credential row. While it waits, a connection is committed for the credential, and a
// sign-in of that account locks it and queues for the credential row behind the request. Then the
// gate commits.
const OCTO = '4242';
const GITHUB_USER_URL = 'https://api.github.com/user';
const SIGN_IN_TOKEN = 'tok-late-sign-in';
const CLIENT: ResolvedOauthClient = {
  clientId: 'device-client',
  clientSecret: null,
  source: 'env',
};
const BLOCKED_WITHIN_MS = 10_000;
const LOCK_TEST_TIMEOUT = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type CredentialRow = typeof schema.repoCredentials.$inferSelect;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

const github = required(getIntegrationProvider('github'), 'the github provider spec');
const device = required(deviceMethodOf(github), "the github spec's device method");

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const describeError = (error: unknown): string =>
  hasPgCode(error, '40P01') ? 'deadlock detected (40P01)' : String(error);

/** Only the github user endpoint is stubbed; anything else answers 404 and no vendor is ever called. */
const githubUserEndpoint = async (input: string | URL | Request) => {
  const target = String(input instanceof Request ? input.url : input);
  return target === GITHUB_USER_URL
    ? Response.json({ id: Number(OCTO), login: 'octo' })
    : new Response('not stubbed', { status: 404 });
};

describe.skipIf(!url)(
  'a delete or an edit of a Git credential beside a connection linked while it waited, on Postgres',
  () => {
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

    const makeUser = async () => {
      const [user] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: `${randomUUID()}@repo-credentials-late-link.test.local`,
          emailBlindIndex: randomBytes(16).toString('hex'),
          passwordHash: 'not-a-real-hash',
          role: 'user',
        })
        .returning({ id: schema.users.id });
      userIds.push(user!.id);
      return user!.id;
    };

    // Really encrypted, so the sign-in can write its token into it and the test can read that back.
    const makeCredential = async () => {
      const dek = generateDek();
      const [row] = await db
        .insert(schema.repoCredentials)
        .values({
          userId,
          label: 'before',
          host: 'github.com',
          provider: 'github',
          usernameEncrypted: encrypt('octo', dek),
          secretEncrypted: encrypt('old-secret', dek),
          encryptedDek: encryptDek(dek, kek),
        })
        .returning();
      return row!;
    };
    const secretOf = (row: CredentialRow) =>
      decrypt(row.secretEncrypted, decryptDek(row.encryptedDek, kek));

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
    const auditActions = async () =>
      (
        await db
          .select({ action: schema.auditEvents.action })
          .from(schema.auditEvents)
          .where(eq(schema.auditEvents.actorUserId, userId))
      )
        .map((row) => row.action)
        .sort();

    // Backends of this database that wait on a lock right now; nothing else in it ever does.
    const lockWaiters = async () => {
      const [row] = await db.execute<{ waiting: number }>(sql`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`);
      return row?.waiting ?? 0;
    };
    const waitForLockWaiters = async (expected: number, what: string, ended: () => boolean) => {
      const deadline = Date.now() + BLOCKED_WITHIN_MS;
      for (;;) {
        if (ended()) throw new Error(`${what} ended without waiting on a lock`);
        if ((await lockWaiters()) === expected) return;
        if (Date.now() > deadline) {
          throw new Error(
            `${expected} lock waiters were not reached within ${BLOCKED_WITHIN_MS} ms`,
          );
        }
        await sleep(20);
      }
    };

    /** The gate holds the credential row; `request` runs against it and finds no connection; a
     *  connection is committed for the credential and a sign-in of its account queues behind the
     *  request; then the gate commits. */
    const lateLinkBesideSignIn = async (request: (credentialId: string) => Promise<Response>) => {
      const credential = await makeCredential();
      const gate = Promise.withResolvers<void>();
      const gateHolds = Promise.withResolvers<void>();
      const gateRun = settle(
        db.transaction(async (tx) => {
          await tx
            .select({ id: schema.repoCredentials.id })
            .from(schema.repoCredentials)
            .where(eq(schema.repoCredentials.id, credential.id))
            .for('no key update');
          gateHolds.resolve();
          await gate.promise;
        }),
      );
      await Promise.race([
        gateHolds.promise,
        gateRun.then(() => {
          throw new Error('the gate ended before it held the credential row');
        }),
      ]);

      let requestEnded = false;
      const response = request(credential.id);
      const markEnded = () => {
        requestEnded = true;
      };
      void response.then(markEnded, markEnded);
      let signIn: Promise<Outcome<unknown>> | undefined;
      let connectionId = '';
      try {
        await waitForLockWaiters(1, 'the request', () => requestEnded);
        // What a sign-in that took the credential back leaves behind.
        const [linked] = await db
          .insert(schema.integrationConnections)
          .values({
            providerId: 'github',
            scope: 'user',
            ownerUserId: userId,
            externalAccountId: OCTO,
            accountLabel: 'octo',
            authMethod: 'device',
            repoCredentialId: credential.id,
          })
          .returning({ id: schema.integrationConnections.id });
        connectionId = linked!.id;
        signIn = settle(
          finishSignIn({
            db,
            userId,
            spec: github,
            method: device,
            client: CLIENT,
            tokens: {
              accessToken: SIGN_IN_TOKEN,
              refreshToken: null,
              expiresAt: null,
              scopes: ['repo'],
            },
            requestedScopes: ['repo'],
          }),
        );
        // The sign-in holds the connection row and queues for the credential row behind the request.
        await waitForLockWaiters(2, 'the sign-in', () => false);
      } finally {
        gate.resolve();
        await Promise.allSettled([gateRun, response, signIn]);
      }

      const [gateOutcome, signInOutcome, res] = await Promise.all([gateRun, signIn!, response]);
      return {
        credential,
        connectionId,
        res,
        failures: [
          ...(gateOutcome.ok ? [] : [`gate: ${describeError(gateOutcome.error)}`]),
          ...(signInOutcome.ok ? [] : [`sign-in: ${describeError(signInOutcome.error)}`]),
        ],
      };
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
      vi.stubGlobal('fetch', vi.fn(githubUserEndpoint));
      userId = await makeUser();
      cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.actorUserId, userIds));
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
      userIds.length = 0;
    });

    it(
      'T1 answers a delete 503 and deletes nothing when the connection linked meanwhile is held by a sign-in, which finishes',
      async () => {
        const run = await lateLinkBesideSignIn((id) => send('DELETE', `/repo-credentials/${id}`));

        expect(run.failures).toEqual([]);
        expect(run.res.status).toBe(503);
        const credential = await credentialRow(run.credential.id);
        expect(credential).toBeDefined();
        expect(secretOf(credential!)).toBe(SIGN_IN_TOKEN);
        expect(await connectionRow(run.connectionId)).toBeDefined();
        expect(await auditActions()).toEqual(['integration.connection.reconnect']);
      },
      LOCK_TEST_TIMEOUT,
    );

    it(
      'T2 answers an edit 503 and changes nothing when the connection linked meanwhile is held by a sign-in, which finishes',
      async () => {
        const run = await lateLinkBesideSignIn((id) =>
          send('PUT', `/repo-credentials/${id}`, {
            label: 'renamed',
            host: 'ghe.example.com',
            provider: 'github',
          }),
        );

        expect(run.failures).toEqual([]);
        expect(run.res.status).toBe(503);
        const credential = await credentialRow(run.credential.id);
        expect(credential).toMatchObject({ label: 'before', host: 'github.com' });
        expect(secretOf(credential!)).toBe(SIGN_IN_TOKEN);
        expect(await connectionRow(run.connectionId)).toMatchObject({
          repoCredentialId: run.credential.id,
        });
        expect(await auditActions()).toEqual(['integration.connection.reconnect']);
      },
      LOCK_TEST_TIMEOUT,
    );
  },
);
