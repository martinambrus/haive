import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, UPGRADE_JOURNAL_DDL } from '@haive/database';
import { lastUpgradeAttempt } from '../src/lib/upgrade-run.js';

const url = process.env.UPGRADE_JOURNAL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t537_test'))
  throw new Error('Use a dedicated t537_test database for upgrade journal tests');

describe.skipIf(!url)('lastUpgradeAttempt on PostgreSQL', () => {
  const db = url ? createDatabase(url) : undefined;
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  it('orders refusals against done runs, prefers a real run on ties and excludes migrate failures', async () => {
    await db!.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL search_path TO pg_temp`);
      await tx.execute(sql.raw(UPGRADE_JOURNAL_DDL));
      await tx.execute(sql`INSERT INTO upgrade_runs
        (from_version, to_version, phase, status, started_at, ended_at)
        VALUES ('1.0.0', '2.0.0', 'done', 'done', '2026-11-06 10:00:00', now())`);
      await tx.execute(sql`INSERT INTO upgrade_runs
        (from_version, to_version, channel, phase, status, metadata, error, started_at, ended_at)
        VALUES ('2.0.0', '3.0.0', 'acme', 'preflight', 'refused',
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
