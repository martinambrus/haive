import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureJournal,
  findLiveRun,
  finishRun,
  lastDoneChannel,
  recordAttempt,
  startRun,
} from '../src/journal.js';

const url = process.env.UPGRADE_JOURNAL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t537_test'))
  throw new Error('Use a dedicated t537_test database for upgrade journal tests');

describe.skipIf(!url)('terminal attempts on PostgreSQL', () => {
  let sql: Sql;
  beforeAll(() => {
    sql = postgres(url!, { max: 1 });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    // max: 1 keeps the temporary journal on the connection used by recordAttempt's transaction.
    await sql`SET search_path TO pg_temp`;
    await ensureJournal(sql);
  });
  afterEach(async () => {
    await sql`DROP TABLE upgrade_runs`;
  });

  async function seedAttempts(count: number): Promise<void> {
    await sql`INSERT INTO upgrade_runs
      (id, from_version, to_version, phase, status, error, started_at, ended_at)
      SELECT lpad(n::text, 32, '0')::uuid, '1.0.0', '2.0.0', 'preflight',
             CASE WHEN n % 2 = 0 THEN 'failed' ELSE 'refused' END, n::text,
             timestamp '2020-02-01' + ((n + 1) / 2) * interval '1 second', now()
        FROM generate_series(1, ${count}::int) AS n`;
  }

  const attempt = {
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    channel: 'public',
    status: 'refused' as const,
    error: '55',
    metadata: {},
  };

  it('retains only the newest 50 attempts, preserving every older non-attempt', async () => {
    await sql`INSERT INTO upgrade_runs
      (from_version, to_version, phase, status, started_at)
      VALUES ('1.0.0', '2.0.0', 'commit', 'done', '2020-01-01'),
             ('1.0.0', '2.0.0', 'verify', 'rolled_back', '2020-01-01'),
             ('1.0.0', '2.0.0', 'preflight', 'running', '2020-01-01'),
             ('1.0.0', '2.0.0', 'migrate', 'failed', '2020-01-01'),
             ('1.0.0', '2.0.0', 'verify', 'refused', '2020-01-01')`;
    const realRuns = await sql`SELECT * FROM upgrade_runs ORDER BY id`;
    // This write makes 55; ranks 50 (n=6) and 51 (n=5) share a timestamp, so id breaks the tie.
    await seedAttempts(54);
    await recordAttempt(sql, attempt);
    const attempts = await sql`SELECT error FROM upgrade_runs
      WHERE phase = 'preflight' AND status IN ('refused', 'failed')
      ORDER BY started_at DESC, id DESC`;
    expect(attempts.map((r) => r.error)).toEqual(
      Array.from({ length: 50 }, (_, i) => String(55 - i)),
    );
    expect(
      await sql`SELECT * FROM upgrade_runs
      WHERE NOT (phase = 'preflight' AND status IN ('refused', 'failed')) ORDER BY id`,
    ).toEqual(realRuns);
  });

  it('preserves the new attempt when 50 existing attempts have future timestamps', async () => {
    await seedAttempts(50);
    await sql`UPDATE upgrade_runs SET started_at = now() + interval '1 day'`;
    await recordAttempt(sql, attempt);
    const rows = await sql`SELECT * FROM upgrade_runs WHERE error = ${attempt.error}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'preflight', status: 'refused' });
    expect(await sql`SELECT id FROM upgrade_runs`).toHaveLength(51);
  });

  it('rolls back both the insertion and pruning if a delete fails', async () => {
    await seedAttempts(54);
    const before = await sql`SELECT * FROM upgrade_runs ORDER BY id`;
    await sql`CREATE FUNCTION pg_temp.reject_attempt_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'attempt pruning rejected';
      END $$`;
    await sql`CREATE TRIGGER reject_attempt_delete BEFORE DELETE ON upgrade_runs
      FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_attempt_delete()`;
    await expect(recordAttempt(sql, attempt)).rejects.toThrow('attempt pruning rejected');
    expect(await sql`SELECT * FROM upgrade_runs ORDER BY id`).toEqual(before);
  });

  it('records a refusal without holding the live slot or changing the completed channel', async () => {
    const done = await startRun(sql, {
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'public',
    });
    await finishRun(sql, done, 'done');
    await recordAttempt(sql, {
      fromVersion: '2.0.0',
      toVersion: '3.0.0',
      channel: 'acme',
      status: 'refused',
      error: 'channel changed',
      metadata: { refusal: 'channel-changed' },
    });
    const rows = await sql`SELECT * FROM upgrade_runs WHERE status = 'refused'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      phase: 'preflight',
      error: 'channel changed',
      metadata: { refusal: 'channel-changed' },
    });
    expect(rows[0]!.ended_at).not.toBeNull();
    expect(await findLiveRun(sql)).toBeNull();
    expect(await lastDoneChannel(sql)).toBe('public');
    const next = await startRun(sql, {
      fromVersion: '2.0.0',
      toVersion: '3.0.0',
      channel: 'acme',
    });
    expect(await findLiveRun(sql)).toMatchObject({
      id: next,
      status: 'running',
    });
  });
});
