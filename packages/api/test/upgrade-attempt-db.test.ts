import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, UPGRADE_JOURNAL_DDL } from '@haive/database';
import { lastUpgradeAttempt, listUpgradeRuns } from '../src/lib/upgrade-run.js';

const url = process.env.UPGRADE_JOURNAL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t537_test'))
  throw new Error('Use a dedicated t537_test database for upgrade journal tests');

describe.skipIf(!url)('lastUpgradeAttempt on PostgreSQL', () => {
  const db = url ? createDatabase(url) : undefined;
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  it('keeps real runs visible behind 25 newer refusals and caps attempts separately', async () => {
    await db!.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('TimeZone', 'UTC', true)`);
      await tx.execute(sql`SET LOCAL search_path TO pg_temp`);
      await tx.execute(sql.raw(UPGRADE_JOURNAL_DDL));
      await tx.execute(sql`INSERT INTO upgrade_runs
        (from_version, to_version, phase, status, started_at, ended_at)
        VALUES ('1.0.0', '2.0.0', 'commit', 'done', '2026-01-01', '2026-01-02'),
               ('2.0.0', '3.0.0', 'verify', 'rolled_back', '2026-01-02', '2026-01-03'),
               ('2.0.0', '3.0.0', 'preflight', 'running', '2026-01-03', NULL)`);
      await tx.execute(sql`INSERT INTO upgrade_runs
        (from_version, to_version, phase, status, started_at, ended_at)
        SELECT '2.0.0', '3.0.0', 'preflight', 'refused',
               timestamp '2026-02-01' + n * interval '1 second', now()
          FROM generate_series(1, 25) AS n`);
      const rows = await listUpgradeRuns(tx);
      expect(rows).toHaveLength(13);
      expect(rows.filter((r) => r.status === 'refused')).toHaveLength(10);
      expect(rows.slice(10).map((r) => r.status)).toEqual(['running', 'rolled_back', 'done']);
      expect(rows.slice(0, 10).map((r) => r.started_at)).toEqual(
        Array.from({ length: 10 }, (_, i) => `2026-02-01T00:00:${25 - i}.000000Z`),
      );
      expect(rows[12]!.ended_at).toBe('2026-01-02T00:00:00.000000Z');
      expect(rows[10]!.ended_at).toBeNull();
      await tx.execute(sql`DROP TABLE upgrade_runs`);
    });
  });

  it('caps non-attempts at 20 and orders tied mixed attempts by descending id', async () => {
    await db!.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL search_path TO pg_temp`);
      await tx.execute(sql.raw(UPGRADE_JOURNAL_DDL));
      await tx.execute(sql`INSERT INTO upgrade_runs
        (id, from_version, to_version, phase, status, started_at)
        SELECT lpad(n::text, 32, '0')::uuid, '1.0.0', '2.0.0',
               CASE WHEN n % 2 = 0 THEN 'migrate' ELSE 'preflight' END,
               CASE WHEN n % 2 = 0 THEN 'failed' ELSE 'done' END,
               timestamp '2026-01-01'
          FROM generate_series(1, 21) AS n`);
      await tx.execute(sql`INSERT INTO upgrade_runs
        (id, from_version, to_version, phase, status, started_at, ended_at)
        SELECT lpad(n::text, 32, '0')::uuid, '1.0.0', '2.0.0', 'preflight',
               CASE WHEN n % 2 = 0 THEN 'failed' ELSE 'refused' END,
               timestamp '2026-01-01', now()
          FROM generate_series(22, 33) AS n`);
      const rows = await listUpgradeRuns(tx);
      expect(rows.map((r) => r.id)).toEqual(
        [
          ...Array.from({ length: 10 }, (_, i) => 33 - i),
          ...Array.from({ length: 20 }, (_, i) => 21 - i),
        ].map((n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`),
      );
      await tx.execute(sql`DROP TABLE upgrade_runs`);
    });
  });

  it('orders refusals against done runs, prefers a real run on ties and excludes migrate failures', async () => {
    await db!.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL search_path TO pg_temp`);
      await tx.execute(sql.raw(UPGRADE_JOURNAL_DDL));
      // A refusal sorts first by id alone, so a tie must be decided by the real-run CASE.
      await tx.execute(sql`INSERT INTO upgrade_runs
        (id, from_version, to_version, phase, status, started_at, ended_at)
        VALUES ('00000000-0000-4000-8000-000000000001',
          '1.0.0', '2.0.0', 'done', 'done', '2026-11-06 10:00:00', now())`);
      await tx.execute(sql`INSERT INTO upgrade_runs
        (id, from_version, to_version, channel, phase, status, metadata, error, started_at, ended_at)
        VALUES ('00000000-0000-4000-8000-000000000002',
          '2.0.0', '3.0.0', 'acme', 'preflight', 'refused',
          '{"refusal":"channel-changed"}'::jsonb, 'reason', '2026-11-06 10:00:01', now())`);
      expect(await lastUpgradeAttempt(tx)).toMatchObject({
        status: 'refused',
        refusal: 'channel-changed',
        error: 'reason',
        channel: 'acme',
        toVersion: '3.0.0',
      });
      await tx.execute(
        sql`UPDATE upgrade_runs SET started_at = '2026-11-06 10:00:00' WHERE status = 'refused'`,
      );
      expect(await lastUpgradeAttempt(tx)).toBeNull();
      await tx.execute(
        sql`UPDATE upgrade_runs SET started_at = '2026-11-06 09:59:59' WHERE status = 'refused'`,
      );
      expect(await lastUpgradeAttempt(tx)).toBeNull();
      await tx.execute(
        sql`UPDATE upgrade_runs SET started_at = '2026-11-06 10:00:01' WHERE status = 'refused'`,
      );
      await tx.execute(sql`INSERT INTO upgrade_runs
        (from_version, to_version, phase, status, started_at, ended_at)
        VALUES ('2.0.0', '3.0.0', 'migrate', 'failed', '2026-11-06 11:00:00', now())`);
      expect(await lastUpgradeAttempt(tx)).toMatchObject({
        status: 'refused',
        refusal: 'channel-changed',
      });
      await tx.execute(sql`DROP TABLE upgrade_runs`);
    });
  });
});
