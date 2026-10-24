import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '@haive/database';
import { logger } from '../src/logger/index.js';
import {
  moduleDatabaseName,
  openModuleDatabase,
  type ModuleDatabase,
} from '../src/module-db/index.js';

const URL_ = process.env.MODULE_DB_WAITER_TEST_URL ?? '';
if (URL_ && !new URL(URL_).pathname.startsWith('/module_db_waiter_test'))
  throw new Error('Use a dedicated module_db_waiter_test database for module db waiter tests');

const GONE_WITHIN_MS = 3000;

const poll = async <T>(read: () => Promise<T>, done: (value: T) => boolean, limitMs: number) => {
  const deadline = Date.now() + limitMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
};

describe.skipIf(!URL_)('an abandoned module database session', () => {
  let db: Database;
  let admin: postgres.Sql;
  const moduleIds: string[] = [];
  const handles: ModuleDatabase[] = [];
  const releases: Array<() => void> = [];
  const pending: Array<Promise<unknown>> = [];

  const open = async (moduleId: string, app: string): Promise<ModuleDatabase> => {
    const previous = process.env.DATABASE_URL;
    const named = new URL(URL_);
    named.searchParams.set('application_name', app);
    process.env.DATABASE_URL = named.toString();
    try {
      const handle = await openModuleDatabase(db, moduleId);
      handles.push(handle);
      return handle;
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  };

  const freshId = (): string => {
    const id = `mdw-${randomBytes(4).toString('hex')}`;
    moduleIds.push(id);
    return id;
  };

  const backends = (app: string, moduleId: string) =>
    admin.unsafe(
      `SELECT pid, state, wait_event_type, wait_event
         FROM pg_stat_activity
        WHERE application_name = $1 AND datname = $2`,
      [app, moduleDatabaseName(moduleId)],
    );

  const hold = async (moduleId: string, app: string) => {
    const handle = await open(moduleId, app);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    releases.push(release);
    const locked = new Promise<void>((resolve, reject) => {
      pending.push(
        handle
          .withSchemaLock(async () => {
            resolve();
            await held;
          })
          .catch(reject),
      );
    });
    await locked;
    return { release, handle };
  };

  beforeAll(() => {
    db = createDatabase(URL_);
    admin = postgres(URL_, { max: 1, onnotice: () => {} });
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await Promise.allSettled(pending.splice(0));
    for (const handle of handles.splice(0)) await handle.close();
  });

  afterAll(async () => {
    for (const id of moduleIds) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${moduleDatabaseName(id)}" WITH (FORCE)`);
    }
    await admin?.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
  });

  it('inherits the startup check interval inside the schema lock', async () => {
    const handle = await open(freshId(), 'mdw-lock-setting');
    const readSetting = (sql: postgres.Sql | postgres.TransactionSql) =>
      sql`SELECT setting::int, source FROM pg_settings
           WHERE name = 'client_connection_check_interval'`;
    const connections = await Promise.all([handle.sql.reserve(), handle.sql.reserve()]);
    try {
      for (const connection of connections) {
        expect(await readSetting(connection)).toMatchObject([{ setting: 500, source: 'client' }]);
      }
    } finally {
      for (const connection of connections) connection.release();
    }
    const locked = await handle.withSchemaLock(readSetting);
    logger.info({ locked }, 'schema lock check interval');
    expect(locked).toMatchObject([{ setting: 500, source: 'client' }]);
  });

  it('ends statements on both sql connections soon after the pool closes', async () => {
    const id = freshId();
    const app = 'mdw-sql-runners';
    const handle = await open(id, app);
    const started = performance.now();
    for (let i = 0; i < 2; i++) {
      pending.push(handle.sql`SELECT pg_sleep(10)`.catch(() => {}));
    }

    const running = await poll(
      () => backends(app, id),
      (rows) => rows.filter((r) => r.wait_event === 'PgSleep').length === 2,
      3000,
    );
    expect(running.filter((r) => r.wait_event === 'PgSleep')).toHaveLength(2);

    await handle.close();
    const closed = performance.now();
    const left = await poll(
      () => backends(app, id),
      (rows) => rows.length === 0,
      GONE_WITHIN_MS,
    );
    const checked = performance.now();
    logger.info(
      {
        closeMs: Math.round(closed - started),
        backendCheckAfterCloseMs: Math.round(checked - closed),
        remaining: left.length,
      },
      'sql pool close measurement',
    );
    expect(left, 'sql backends still on the server after close').toHaveLength(0);
    expect(checked - started, 'backends ended well before pg_sleep(10) could finish').toBeLessThan(
      8500,
    );
  }, 30_000);

  it('leaves the server soon after its pool closes while it waits for the lock', async () => {
    const id = freshId();
    await hold(id, 'mdw-holder-1');
    const waiter = await open(id, 'mdw-waiter-1');
    pending.push(waiter.withSchemaLock(async () => 'ran').catch(() => {}));

    const waiting = await poll(
      () => backends('mdw-waiter-1', id),
      (rows) => rows.some((r) => r.state === 'active' && r.wait_event_type === 'Lock'),
      10_000,
    );
    expect(
      waiting.some((r) => r.wait_event_type === 'Lock'),
      'waiter reached the lock wait',
    ).toBe(true);

    await waiter.close();
    const left = await poll(
      () => backends('mdw-waiter-1', id),
      (rows) => rows.length === 0,
      GONE_WITHIN_MS,
    );
    expect(left, 'waiter backends still on the server after close').toHaveLength(0);
    expect(await backends('mdw-holder-1', id), 'holder backend still held').not.toHaveLength(0);
  }, 30_000);

  it('leaves the server soon after its pool closes while it runs a statement', async () => {
    const id = freshId();
    const handle = await open(id, 'mdw-runner-2');
    pending.push(
      handle
        .withSchemaLock(async (tx) => {
          await tx`SELECT pg_sleep(60)`;
        })
        .catch(() => {}),
    );

    const running = await poll(
      () => backends('mdw-runner-2', id),
      (rows) => rows.some((r) => r.wait_event === 'PgSleep'),
      10_000,
    );
    expect(
      running.some((r) => r.wait_event === 'PgSleep'),
      'statement reached pg_sleep',
    ).toBe(true);

    await handle.close();
    const left = await poll(
      () => backends('mdw-runner-2', id),
      (rows) => rows.length === 0,
      GONE_WITHIN_MS,
    );
    expect(left, 'runner backends still on the server after close').toHaveLength(0);
  }, 30_000);

  it('still lets a waiter run when the lock frees after several check intervals', async () => {
    const id = freshId();
    const holder = await hold(id, 'mdw-holder-3');
    const waiter = await open(id, 'mdw-waiter-3');
    const result = waiter.withSchemaLock(async () => 'ran');

    const waiting = await poll(
      () => backends('mdw-waiter-3', id),
      (rows) => rows.some((r) => r.wait_event_type === 'Lock'),
      10_000,
    );
    expect(
      waiting.some((r) => r.wait_event_type === 'Lock'),
      'waiter reached the lock wait',
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    holder.release();
    await expect(result).resolves.toBe('ran');
  }, 30_000);
});
