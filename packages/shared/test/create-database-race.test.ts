import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { resolveGlobalKbConnection, GLOBAL_KB_DB_NAME } from '../src/global-kb/connection.js';
import { resolveRagConnection, ragDatabaseName } from '../src/rag/connection.js';

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
    await admin.end({ timeout: 5 });
  });

  it('resolves both per-project RAG creators', async () => {
    const prefs = {
      ragMode: 'internal' as const,
      ragConnectionString: null,
      ollamaUrl: null,
      embeddingModel: null,
      embeddingDimensions: 8,
    };
    const both = await Promise.all([
      resolveRagConnection(prefs, racing, project),
      resolveRagConnection(prefs, racing, project),
    ]);
    expect(both.map((c) => c?.mode)).toEqual(['internal', 'internal']);
    await Promise.all(both.map((c) => c?.close()));
  });

  it('resolves both global KB creators', async () => {
    await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${GLOBAL_KB_DB_NAME}" WITH (FORCE)`));
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
    const both = await Promise.all([
      resolveGlobalKbConnection(settings, racing),
      resolveGlobalKbConnection(settings, racing),
    ]);
    expect(both.map((c) => c.mode)).toEqual(['internal', 'internal']);
    await Promise.all(both.map((c) => c.close()));
  });
});
