import { randomBytes, randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database, type DbTx } from '@haive/database';
import type { IntegrationBinding } from '../src/integrations/index.js';

const url = process.env.INTEGRATIONS_TASK_LOCK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integrations_task_lock_test'))
  throw new Error('Use a dedicated integrations_task_lock_test database for the task lock tests');

interface Connection {
  id: string;
  providerId: string;
  scope: 'user' | 'shared';
  ownerUserId: string;
  status: string;
}

const shared = (await import('../src/integrations/index.js')) as {
  lockTaskIntegrations?: (tx: DbTx, taskId: string) => Promise<void>;
  writeAllowedBy?: (
    db: Database,
    ownerId: string,
    connections: ReadonlyMap<string, Connection>,
  ) => Promise<(binding: IntegrationBinding) => boolean>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tryLock = (tx: DbTx, taskId: string) =>
  tx.execute<{ ok: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`task-integrations:${taskId}`}, 0)) as ok`,
  );

function lockTaskIntegrations(): NonNullable<typeof shared.lockTaskIntegrations> {
  expect(
    typeof shared.lockTaskIntegrations,
    '@haive/shared/integrations does not export lockTaskIntegrations',
  ).toBe('function');
  return shared.lockTaskIntegrations!;
}

function writeAllowedBy(): NonNullable<typeof shared.writeAllowedBy> {
  expect(
    typeof shared.writeAllowedBy,
    '@haive/shared/integrations does not export writeAllowedBy',
  ).toBe('function');
  return shared.writeAllowedBy!;
}

describe.skipIf(!url)('the task integrations lock and the write switch, on Postgres', () => {
  let db: Database;
  const userIds: string[] = [];

  beforeAll(() => {
    db = createDatabase(url as string);
  });

  afterAll(async () => {
    if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await db.$client.end({ timeout: 5 });
  });

  async function createUser(): Promise<string> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'integrations-task-lock-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    return user!.id;
  }

  describe('[D9] lockTaskIntegrations', () => {
    it('[D9] holds the lock keyed task-integrations:<taskId> until the transaction ends', async () => {
      const lock = lockTaskIntegrations();
      const taskId = randomUUID();
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holder = db.transaction(async (tx) => {
        await lock(tx, taskId);
        held.resolve();
        await release.promise;
      });
      await held.promise;

      try {
        const [sameTask, otherTask] = await db.transaction(async (tx) => [
          (await tryLock(tx, taskId))[0]!.ok,
          (await tryLock(tx, randomUUID()))[0]!.ok,
        ]);

        expect(sameTask, 'the lock was not taken under the documented key').toBe(false);
        expect(otherTask, 'a lock of one task must not hold another').toBe(true);
      } finally {
        release.resolve();
        await holder;
      }

      const [released] = await db.transaction(async (tx) => tryLock(tx, taskId));
      expect(released!.ok, 'the lock outlived its transaction').toBe(true);
    });

    it('[D9] makes a second taker of the same task wait for the first to commit', async () => {
      const lock = lockTaskIntegrations();
      const taskId = randomUUID();
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const first = db.transaction(async (tx) => {
        await lock(tx, taskId);
        held.resolve();
        await release.promise;
      });
      await held.promise;

      try {
        const second = db.transaction((tx) => lock(tx, taskId));

        expect(await Promise.race([second, sleep(500).then(() => 'waiting')])).toBe('waiting');
        release.resolve();
        await first;
        await second;
      } finally {
        release.resolve();
        await first.catch(() => undefined);
      }
    });
  });

  describe('[D10] writeAllowedBy', () => {
    const binding = (connectionId: string, providerId = 'github'): IntegrationBinding => ({
      requirementId: 'pull-requests',
      categoryId: 'forge',
      providerId,
      connectionId,
      access: 'write',
    });
    const connection = (ownerUserId: string, providerId = 'github'): Connection => ({
      id: randomUUID(),
      providerId,
      scope: 'user',
      ownerUserId,
      status: 'connected',
    });
    const setSwitch = (userId: string, providerId: string, writeEnabled: boolean) =>
      db.insert(schema.integrationUserSettings).values({ userId, providerId, writeEnabled });

    it('[D10] allows a write while the owner switch of the binding provider is on and the connection is known', async () => {
      const allowedBy = writeAllowedBy();
      const owner = await createUser();
      const known = connection(owner);
      await setSwitch(owner, 'github', true);

      const allowed = await allowedBy(db, owner, new Map([[known.id, known]]));

      expect(allowed(binding(known.id))).toBe(true);
    });

    it('[D10] refuses a write while the switch is off, was never set, or is on for another provider', async () => {
      const allowedBy = writeAllowedBy();
      const off = await createUser();
      const never = await createUser();
      const other = await createUser();
      const offConnection = connection(off);
      const neverConnection = connection(never);
      const otherConnection = connection(other);
      await setSwitch(off, 'github', false);
      await setSwitch(other, 'gitlab', true);

      expect(
        (await allowedBy(db, off, new Map([[offConnection.id, offConnection]])))(
          binding(offConnection.id),
        ),
      ).toBe(false);
      expect(
        (await allowedBy(db, never, new Map([[neverConnection.id, neverConnection]])))(
          binding(neverConnection.id),
        ),
      ).toBe(false);
      expect(
        (await allowedBy(db, other, new Map([[otherConnection.id, otherConnection]])))(
          binding(otherConnection.id),
        ),
      ).toBe(false);
    });

    it('[D10] refuses a write for a connection it was not given, though the switch is on', async () => {
      const allowedBy = writeAllowedBy();
      const owner = await createUser();
      await setSwitch(owner, 'github', true);

      const allowed = await allowedBy(db, owner, new Map());

      expect(allowed(binding(randomUUID()))).toBe(false);
    });

    it('[D10] reads the switch of the owner it is given, not of another user', async () => {
      const allowedBy = writeAllowedBy();
      const owner = await createUser();
      const stranger = await createUser();
      const known = connection(owner);
      await setSwitch(stranger, 'github', true);

      const allowed = await allowedBy(db, owner, new Map([[known.id, known]]));

      expect(allowed(binding(known.id))).toBe(false);
    });
  });
});
