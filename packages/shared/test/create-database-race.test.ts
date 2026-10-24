import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { resolveGlobalKbConnection, GLOBAL_KB_DB_NAME } from '../src/global-kb/connection.js';
import {
  openExistingRagDatabase,
  resolveRagConnection,
  ragDatabaseName,
} from '../src/rag/connection.js';
import { logger } from '../src/logger/index.js';

// Store names take the install id at import, so a run of its own never drops another install's store.
const installBefore = vi.hoisted(() => {
  const before = process.env.HAIVE_INSTALL_ID;
  process.env.HAIVE_INSTALL_ID = `race_${crypto.randomUUID().slice(0, 8)}`;
  return before;
});

const RACE_PG_URL = process.env.RACE_PG_URL;

describe.skipIf(!RACE_PG_URL)('two creators of one fresh store, against a real Postgres', () => {
  const project = `race${Date.now()}`;
  const before = process.env.DATABASE_URL;
  let admin: postgres.Sql;
  let db: Database;
  // Both callers must see the store as absent, which is the window being tested.
  let racing: Database;

  beforeAll(() => {
    process.env.DATABASE_URL = RACE_PG_URL;
    admin = postgres(RACE_PG_URL!, { max: 4 });
    db = drizzle(admin) as unknown as Database;
    racing = {
      execute: (query: Parameters<Database['execute']>[0]) =>
        JSON.stringify(query).includes('SELECT 1 FROM pg_database')
          ? Promise.resolve([])
          : db.execute(query),
    } as unknown as Database;
  });

  afterAll(async () => {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
    for (const name of [ragDatabaseName(project), GLOBAL_KB_DB_NAME]) {
      await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    }
    if (installBefore === undefined) delete process.env.HAIVE_INSTALL_ID;
    else process.env.HAIVE_INSTALL_ID = installBefore;
    await admin.end({ timeout: 5 });
  });

  const prefs = {
    ragMode: 'internal' as const,
    ragConnectionString: null,
    ollamaUrl: null,
    embeddingModel: null,
    embeddingDimensions: 8,
  };

  const settings = {
    enabled: true,
    digestEnabled: true,
    mode: 'internal' as const,
    namespace: 'default',
    connectionString: null,
    ollamaUrl: null,
    embedModel: null,
    embeddingDimensions: 8,
    archiveRetentionDays: 30,
  };

  it('resolves both per-project RAG creators', async () => {
    const both = await Promise.all([
      resolveRagConnection(prefs, racing, project),
      resolveRagConnection(prefs, racing, project),
    ]);
    expect(both.map((c) => c?.mode)).toEqual(['internal', 'internal']);
    await Promise.all(both.map((c) => c?.close()));
  });

  it('resolves both global KB creators', async () => {
    await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${GLOBAL_KB_DB_NAME}" WITH (FORCE)`));
    const both = await Promise.all([
      resolveGlobalKbConnection(settings, racing),
      resolveGlobalKbConnection(settings, racing),
    ]);
    expect(both.map((c) => c.mode)).toEqual(['internal', 'internal']);
    await Promise.all(both.map((c) => c.close()));
  });

  it.each(['rag', 'existing-rag', 'global-kb'] as const)(
    'ends statements on every internal %s connection after close',
    async (kind) => {
      const conn =
        kind === 'global-kb'
          ? await resolveGlobalKbConnection(settings, db)
          : kind === 'existing-rag'
            ? await openExistingRagDatabase(db, ragDatabaseName(project), 8)
            : await resolveRagConnection(prefs, db, project);
      expect(conn).not.toBeNull();
      if (!conn) throw new Error('internal store was not opened');
      const connections = await Promise.all(
        Array.from({ length: conn.pg.options.max }, () => conn.pg.reserve()),
      );
      const sessions = [];
      try {
        for (const connection of connections) {
          const [session] = await connection`SELECT pg_backend_pid() AS pid, setting::int, source
            FROM pg_settings WHERE name = 'client_connection_check_interval'`;
          sessions.push(session!);
        }
      } finally {
        for (const connection of connections) connection.release();
      }
      const pids = sessions.map((session) => session.pid);
      const backends = () =>
        admin`SELECT pid, wait_event FROM pg_stat_activity WHERE pid = ANY(${pids})`;
      const poll = async (done: (rows: Awaited<ReturnType<typeof backends>>) => boolean) => {
        const deadline = performance.now() + 3000;
        let rows = await backends();
        while (!done(rows) && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          rows = await backends();
        }
        return rows;
      };
      const started = performance.now();
      const pending = Array.from({ length: conn.pg.options.max }, () =>
        conn.pg`SELECT pg_sleep(10)`.catch(() => {}),
      );
      try {
        const running = await poll((rows) => rows.every((r) => r.wait_event === 'PgSleep'));
        expect(running.filter((r) => r.wait_event === 'PgSleep')).toHaveLength(pids.length);
        await conn.close();
        const closed = performance.now();
        const left = await poll((rows) => rows.length === 0);
        const checked = performance.now();
        logger.info(
          {
            kind,
            poolSize: pids.length,
            closeMs: Math.round(closed - started),
            backendCheckAfterCloseMs: Math.round(checked - closed),
            remaining: left.length,
          },
          'internal store pool close measurement',
        );
        expect(left, 'internal store backends still on the server after close').toHaveLength(0);
        expect(checked - started).toBeLessThan(8500);
        expect(sessions).toEqual(pids.map((pid) => ({ pid, setting: 500, source: 'client' })));
      } finally {
        await conn.close();
        await Promise.allSettled(pending);
      }
    },
    30_000,
  );
});
