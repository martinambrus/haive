import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('records a refusal without holding the live slot or changing the completed channel', async () => {
    // A reserved session keeps this temporary journal isolated from every other test file.
    const session = await sql.reserve();
    try {
      await session`BEGIN`;
      await session`SET LOCAL search_path TO pg_temp`;
      await ensureJournal(session as unknown as Sql);
      const done = await startRun(session as unknown as Sql, {
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        channel: 'public',
      });
      await finishRun(session as unknown as Sql, done, 'done');
      await recordAttempt(session as unknown as Sql, {
        fromVersion: '2.0.0',
        toVersion: '3.0.0',
        channel: 'acme',
        status: 'refused',
        error: 'channel changed',
        metadata: { refusal: 'channel-changed' },
      });
      const rows = await session`SELECT * FROM upgrade_runs WHERE status = 'refused'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        phase: 'preflight',
        error: 'channel changed',
        metadata: { refusal: 'channel-changed' },
      });
      expect(rows[0]!.ended_at).not.toBeNull();
      expect(await findLiveRun(session as unknown as Sql)).toBeNull();
      expect(await lastDoneChannel(session as unknown as Sql)).toBe('public');
      const next = await startRun(session as unknown as Sql, {
        fromVersion: '2.0.0',
        toVersion: '3.0.0',
        channel: 'acme',
      });
      expect(await findLiveRun(session as unknown as Sql)).toMatchObject({
        id: next,
        status: 'running',
      });
    } finally {
      await session`ROLLBACK`;
      session.release();
    }
  });
});
