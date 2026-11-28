import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withGlobalKb } from '../src/global-kb/client.js';
import type { GlobalKbSettings } from '../src/global-kb/connection.js';

// Needs a server with pgvector. HAIVE_GKB_TEST_DB_URL is any superuser URL on it,
// and the test works in a scratch database it creates and drops.
const ADMIN_URL = process.env.HAIVE_GKB_TEST_DB_URL ?? '';
const SCHEMA_LOCK_KEY = 'haive:global-kb-schema';
const APP = 'fnf41-ensure-bound';
const HOLDER_APP = 'fnf41-lock-holder';
const SCRATCH_DB = `fnf41_${process.pid}_${Date.now()}`;
const DEADLINE_MS = 1000;

const withDatabase = (url: string, database: string, applicationName?: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (applicationName) parsed.searchParams.set('application_name', applicationName);
  return parsed.toString();
};

describe.skipIf(!ADMIN_URL)('the schema ensure of a bounded call', () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  let holder: postgres.Sql | undefined;
  let release: () => void = () => {};
  let holding: Promise<unknown> = Promise.resolve();

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
  });

  afterAll(async () => {
    release();
    await holding.catch(() => {});
    await holder?.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it('leaves no backend waiting on the schema lock after its deadline answered', async () => {
    holder = postgres(withDatabase(ADMIN_URL, SCRATCH_DB, HOLDER_APP), {
      max: 1,
      onnotice: () => {},
    });
    const held = new Promise<void>((resolve) => (release = resolve));
    const locked = new Promise<void>((resolve) => {
      holding = holder!.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${SCHEMA_LOCK_KEY}))`;
        resolve();
        await held;
      });
    });
    await locked;

    const settings: GlobalKbSettings = {
      enabled: true,
      digestEnabled: true,
      mode: 'external',
      namespace: 'default',
      connectionString: withDatabase(ADMIN_URL, SCRATCH_DB, APP),
      ollamaUrl: null,
      embedModel: null,
      embeddingDimensions: 8,
      archiveRetentionDays: 30,
    };

    const started = Date.now();
    const outcome = await withGlobalKb({} as never, async () => 'ran', {
      deadlineMs: DEADLINE_MS,
      settings,
    }).then(
      () => 'resolved',
      () => 'rejected',
    );
    const ms = Date.now() - started;
    expect(outcome).toBe('rejected');
    expect(ms, 'ms until the call rejected').toBeLessThan(DEADLINE_MS + 500);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const waiting = await admin.unsafe(
      `SELECT a.pid, a.state, left(a.query, 80) AS query
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND NOT l.granted
          AND a.application_name = $1 AND a.datname = $2`,
      [APP, SCRATCH_DB],
    );
    expect(waiting, 'backends of this test still waiting on the schema lock').toHaveLength(0);
  }, 30_000);
});

// Run only with the gated runner's throwaway server. Refuse an existing built-in database:
// the test owns only the database it creates, even if someone supplies the wrong admin URL.
describe.skipIf(!ADMIN_URL)('internal database readiness after a drop', () => {
  it('recreates a dropped store on the next bare connection call', async () => {
    const { GLOBAL_KB_DB_NAME } = await import('../src/global-kb/connection.js');
    const { withGlobalKbConnection } = await import('../src/global-kb/client.js');
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    const before = process.env.DATABASE_URL;
    let owned = false;
    try {
      const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${GLOBAL_KB_DB_NAME}`;
      expect(existing, 'refusing to touch an existing built-in KB database').toHaveLength(0);
      process.env.DATABASE_URL = ADMIN_URL;
      const settings: GlobalKbSettings = {
        enabled: true,
        digestEnabled: true,
        mode: 'internal',
        namespace: 'drop-control',
        connectionString: null,
        ollamaUrl: null,
        embedModel: null,
        embeddingDimensions: 8,
        archiveRetentionDays: 30,
      };
      const run = () =>
        withGlobalKbConnection(
          {} as never,
          async ({ conn }) => {
            const rows = await conn.pg`SELECT current_database() AS name`;
            return rows[0]!.name;
          },
          { settings, deadlineMs: 5000 },
        );
      owned = true;
      expect(await run()).toBe(GLOBAL_KB_DB_NAME);
      await admin.unsafe(`DROP DATABASE "${GLOBAL_KB_DB_NAME}" WITH (FORCE)`);
      await expect(run()).rejects.toMatchObject({ code: '3D000' });
      expect(await run(), 'next call must bootstrap the missing database').toBe(GLOBAL_KB_DB_NAME);
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
      if (owned) await admin.unsafe(`DROP DATABASE IF EXISTS "${GLOBAL_KB_DB_NAME}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });
});
