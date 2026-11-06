import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, UPGRADE_JOURNAL_DDL, type DbTx } from '@haive/database';
import { lastUpgradeAttempt, listUpgradeRuns } from '../src/lib/upgrade-run.js';

const url = process.env.UPGRADE_JOURNAL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t537_test'))
  throw new Error('Use a dedicated t537_test database for upgrade journal tests');

describe.skipIf(!url)('upgrade timestamp wire format on PostgreSQL', () => {
  const db = url ? createDatabase(url) : undefined;
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  it.each(['UTC', 'Europe/Berlin', 'America/New_York'])(
    'returns actual ISO instants from the %s session wall clock',
    async (zone) => {
      await db!.transaction(async (tx: DbTx) => {
        await tx.execute(sql`SELECT set_config('TimeZone', ${zone}, true)`);
        await tx.execute(
          sql.raw(
            UPGRADE_JOURNAL_DDL.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE').replace(
              ');\nCREATE UNIQUE',
              ') ON COMMIT DROP;\nCREATE UNIQUE',
            ),
          ),
        );
        await tx.execute(sql`INSERT INTO upgrade_runs
          (from_version, to_version, phase, status, ended_at)
          VALUES ('1.0.0', '2.0.0', 'preflight', 'running', NULL),
                 ('1.0.0', '2.0.0', 'preflight', 'refused', now())`);
        const raw = await tx.execute<{ started_at: string; epoch: string }>(sql`
          SELECT started_at, extract(epoch FROM now())::text AS epoch FROM upgrade_runs LIMIT 1`);
        // Drizzle installs identity timestamp parsers: this is a wall clock, not a Date or UTC.
        expect(typeof raw[0]!.started_at).toBe('string');
        expect(raw[0]!.started_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
        const expected = Number(raw[0]!.epoch) * 1000;
        const instant = (value: unknown) => {
          expect(value).toEqual(
            expect.stringMatching(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
            ),
          );
          expect(Math.abs(Date.parse(value as string) - expected)).toBeLessThan(1);
        };
        const runs = await listUpgradeRuns(tx);
        expect(runs).toHaveLength(2);
        for (const run of runs) {
          instant(run.started_at);
          if (run.status === 'running') expect(run.ended_at).toBeNull();
          else instant(run.ended_at);
        }
        // A terminal attempt must be newer than the real run, rather than a tie.
        await tx.execute(sql`UPDATE upgrade_runs SET started_at = started_at - interval '1 second'
          WHERE status = 'running'`);
        instant((await lastUpgradeAttempt(tx))!.startedAt);
      });
    },
  );
});
