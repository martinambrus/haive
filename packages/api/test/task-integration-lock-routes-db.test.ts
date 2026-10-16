import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database, type DbTx } from '@haive/database';

const url = process.env.TASK_INTEGRATION_LOCK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_integration_lock_test'))
  throw new Error(
    'Use a dedicated task_integration_lock_test database for the task lock route tests',
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
    getBoolean: async (_key: string, fallback: boolean) => fallback,
  },
}));

import { secretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';

const WEB_ORIGIN = 'http://localhost:3000';
const GITHUB_REMOTE = 'https://github.com/acme/widgets.git';
const FORGE = 'forge';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lockSql = (taskId: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`task-integrations:${taskId}`}, 0))`;

describe.skipIf(!url)('the task integration routes and the dispatch lock, on Postgres', () => {
  const app = createApiApp(WEB_ORIGIN);
  let db: Database;
  let userId: string;
  let cookie: string;
  let repositoryId: string;
  let first: string;
  let second: string;
  const userIds: string[] = [];

  async function createAccount(owner: string): Promise<string> {
    const [credential] = await db
      .insert(schema.repoCredentials)
      .values({
        userId: owner,
        label: `credential ${randomUUID()}`,
        host: 'github.com',
        provider: 'github',
        usernameEncrypted: 'x',
        secretEncrypted: 'x',
        encryptedDek: 'x',
      })
      .returning({ id: schema.repoCredentials.id });
    const [connection] = await db
      .insert(schema.integrationConnections)
      .values({
        providerId: 'github',
        scope: 'user',
        ownerUserId: owner,
        accountLabel: `account ${randomUUID()}`,
        authMethod: 'token',
        repoCredentialId: credential!.id,
      })
      .returning({ id: schema.integrationConnections.id });
    return connection!.id;
  }

  async function createTask(): Promise<string> {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'workflow',
        title: 'task integration lock test',
        status: 'running',
      })
      .returning({ id: schema.tasks.id });
    await db
      .insert(schema.taskIntegrationChoices)
      .values({ taskId: task!.id, categoryId: FORGE, providerId: 'github', connectionId: first });
    await db
      .insert(schema.integrationGrants)
      .values({ targetKind: 'task', taskId: task!.id, categoryId: FORGE, connectionId: first });
    return task!.id;
  }

  const path = (taskId: string) => `/tasks/${taskId}/integrations/${FORGE}`;
  const send = (method: 'PUT' | 'DELETE', taskId: string, body?: unknown) =>
    app.request(path(taskId), {
      method,
      headers: {
        host: 'localhost:3001',
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const choiceOf = async (taskId: string) =>
    (
      await db
        .select()
        .from(schema.taskIntegrationChoices)
        .where(eq(schema.taskIntegrationChoices.taskId, taskId))
    ).map((row) => row.connectionId);
  const grantsOf = async (taskId: string) =>
    (
      await db
        .select()
        .from(schema.integrationGrants)
        .where(
          and(
            eq(schema.integrationGrants.targetKind, 'task'),
            eq(schema.integrationGrants.taskId, taskId),
          ),
        )
    ).map((row) => row.connectionId);

  async function waiters(): Promise<number> {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
    );
    return rows[0]!.n;
  }

  /** A row lock taken and released again at once: it fails when a writer of the row is still open. */
  async function rowsAreFree(taskId: string): Promise<boolean> {
    try {
      await db.transaction(async (tx: DbTx) => {
        await tx.execute(
          sql`select 1 from task_integration_choices where task_id = ${taskId} for update nowait`,
        );
        await tx.execute(
          sql`select 1 from integration_grants where task_id = ${taskId} for update nowait`,
        );
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Holds the dispatch's lock of a task, the way its stamp transaction does, until released. */
  async function holdLock(taskId: string) {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = db.transaction(async (tx) => {
      await tx.execute(lockSql(taskId));
      held.resolve();
      await release.promise;
    });
    await held.promise;
    return {
      release: async () => {
        release.resolve();
        await holder;
      },
    };
  }

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'task-integration-lock-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role: 'user',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;
    userIds.push(userId);
    cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    const [repository] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'lock routes', source: 'git_https', remoteUrl: GITHUB_REMOTE })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
    first = await createAccount(userId);
    second = await createAccount(userId);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await db.$client.end({ timeout: 5 });
  });

  const CASES: ReadonlyArray<readonly ['DELETE' | 'PUT', () => unknown]> = [
    ['DELETE', () => undefined],
    ['PUT', () => ({ providerId: 'github', connectionId: second })],
  ];

  describe.each(CASES)('[D9] %s of a task choice', (method, bodyOf) => {
    it('[D9] answers while no dispatch holds the lock (passes before and after)', async () => {
      const taskId = await createTask();

      const res = await send(method, taskId, bodyOf());

      expect(res.status).toBe(200);
      expect(await choiceOf(taskId)).toEqual(method === 'DELETE' ? [] : [second]);
    });

    it('[D9] waits while a dispatch holds the task lock, writing nothing, then applies', async () => {
      const taskId = await createTask();
      const lock = await holdLock(taskId);

      try {
        const pending = send(method, taskId, bodyOf());

        expect(await Promise.race([pending, sleep(700).then(() => 'waiting')])).toBe('waiting');
        expect(await waiters(), 'it waits on the advisory lock').toBeGreaterThanOrEqual(1);
        expect(await rowsAreFree(taskId), 'it wrote before it took the lock').toBe(true);
        expect(await choiceOf(taskId)).toEqual([first]);
        expect(await grantsOf(taskId)).toEqual([first]);
        await lock.release();

        const res = await pending;
        expect(res.status).toBe(200);
        expect(await choiceOf(taskId)).toEqual(method === 'DELETE' ? [] : [second]);
      } finally {
        await lock.release();
      }
    }, 30_000);

    it('[D9+] is not delayed by the lock of another task (passes before and after)', async () => {
      const mine = await createTask();
      const other = await createTask();
      const lock = await holdLock(other);

      try {
        const res = await Promise.race([
          send(method, mine, bodyOf()),
          sleep(5000).then(() => null),
        ]);

        expect(res?.status).toBe(200);
      } finally {
        await lock.release();
      }
    }, 30_000);
  });
});
