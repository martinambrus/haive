import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { liveTaskCount } from '../src/run.js';

const url = process.env.UPDATER_LIVE_COUNT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/updater_live_count_test'))
  throw new Error('Use a dedicated updater_live_count_test database for the live task count tests');

const OWNER = '00000000-0000-4000-8000-0000000000f1';
const BLIND_INDEX = 'updater-live-count-test-owner';
const TYPE = 'updater-live-count-test';
const LIVE = ['created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr'];
const FINISHED = ['completed', 'failed', 'cancelled'];

describe.skipIf(!url)('liveTaskCount on Postgres', () => {
  let sql: Sql;

  const task = (status: string, over: { deadAt?: Date; deadReason?: string } = {}) =>
    sql`INSERT INTO tasks (user_id, type, title, status, dead_at, dead_reason)
        VALUES (${OWNER}, ${TYPE}, 'Task', ${status}, ${over.deadAt ?? null}, ${over.deadReason ?? null})`;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 1 });
    await sql`DELETE FROM users WHERE email_blind_index = ${BLIND_INDEX}`;
    await sql`INSERT INTO users (id, email_encrypted, email_blind_index, password_hash)
              VALUES (${OWNER}, 'not-real', ${BLIND_INDEX}, 'not-real')`;
  });

  beforeEach(async () => {
    await sql`DELETE FROM tasks WHERE type = ${TYPE}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE email_blind_index = ${BLIND_INDEX}`;
    await sql.end({ timeout: 5 });
  });

  it('counts a task in every live status', async () => {
    for (const status of LIVE) await task(status);

    expect(await liveTaskCount(sql)).toBe(LIVE.length);
  });

  it('counts a running task and not a dead running one beside it', async () => {
    await task('running');
    await task('running', { deadAt: new Date() });

    expect(await liveTaskCount(sql)).toBe(1);
  });

  it('leaves a dead task out whatever live status it died in', async () => {
    for (const status of LIVE) await task(status, { deadAt: new Date() });

    expect(await liveTaskCount(sql)).toBe(0);
  });

  it('keys on dead_at, so a dead_reason that outlived it still counts the task', async () => {
    await task('running', { deadReason: 'a step was missing once' });

    expect(await liveTaskCount(sql)).toBe(1);
  });

  it('does not count a finished task', async () => {
    for (const status of FINISHED) await task(status);

    expect(await liveTaskCount(sql)).toBe(0);
  });
});
