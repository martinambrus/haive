import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import { ensureJournal, finishRun, startRun } from '../src/journal.js';
import { phaseDraining, type UpgradeContext } from '../src/run.js';

const url = process.env.UPDATER_FENCE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/updater_fence_test'))
  throw new Error('Use a dedicated updater_fence_test database for the new-work fence tests');

const OWNER = '00000000-0000-4000-8000-0000000000f7';
const BLIND_INDEX = 'updater-fence-test-owner';
const TYPE = 'updater-fence-test';
const FENCE = 'haive-new-work-fence';

describe.skipIf(!url)('the new-work fence, taken by the drain, on Postgres', () => {
  let updater: Sql;
  let admission: Sql;
  let probe: Sql;
  let runId: string;
  let written: string[];
  let logged: { event: string; fields?: Record<string, unknown> }[];
  let proceed: () => void;
  let inFlight: Promise<unknown> | undefined;

  const context = () =>
    ({
      sql: updater,
      runId,
      drainDeadlineMs: 0,
      forceDrain: true,
      log: (event: string, fields?: Record<string, unknown>) => logged.push({ event, fields }),
    }) as unknown as UpgradeContext;

  /** An api request between taking the fence and committing its task. */
  const admitTask = async () => {
    const proceeding = new Promise<void>((resolve) => (proceed = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    inFlight = admission.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock_shared(hashtextextended(${FENCE}, 0))`;
      held();
      await proceeding;
      await tx`INSERT INTO tasks (user_id, type, title, status)
               VALUES (${OWNER}, ${TYPE}, 'Task', 'queued')`;
    });
    await holding;
  };

  const untilWaiting = async () => {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const [row] = await probe<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock'`;
      if (row && row.n > 0) return;
      if (Date.now() > deadline) throw new Error('the drain never waited for the new-work fence');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const fenceIsFree = async () => {
    const [row] = await probe<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${FENCE}, 0)) AS locked`;
    if (row?.locked) await probe`SELECT pg_advisory_unlock(hashtextextended(${FENCE}, 0))`;
    return row?.locked === true;
  };

  beforeAll(async () => {
    updater = postgres(url as string, { max: 1, max_lifetime: 0 });
    admission = postgres(url as string, { max: 1 });
    probe = postgres(url as string, { max: 1 });
    await ensureJournal(updater);
    await updater`DELETE FROM users WHERE email_blind_index = ${BLIND_INDEX}`;
    await updater`INSERT INTO users (id, email_encrypted, email_blind_index, password_hash)
                  VALUES (${OWNER}, 'not-real', ${BLIND_INDEX}, 'not-real')`;
  });

  beforeEach(async () => {
    written = [];
    logged = [];
    inFlight = undefined;
    await updater`DELETE FROM tasks WHERE type = ${TYPE}`;
    runId = await startRun(updater, {
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      channel: 'public',
    });
    vi.spyOn(configService, 'set').mockImplementation(async (_key, value) => {
      written.push(value);
    });
  });

  afterEach(async () => {
    proceed?.();
    await inFlight?.catch(() => undefined);
    await finishRun(updater, runId, 'rolled_back');
  });

  afterAll(async () => {
    await updater`DELETE FROM users WHERE email_blind_index = ${BLIND_INDEX}`;
    await updater.end({ timeout: 5 });
    await admission.end({ timeout: 5 });
    await probe.end({ timeout: 5 });
  });

  it('writes the draining state at once when no admission holds the fence, and lets the fence go', async () => {
    await phaseDraining(context());

    expect(written).toEqual(['draining']);
    expect(logged.map((l) => l.event)).toEqual(['draining', 'drained']);
    expect(await fenceIsFree()).toBe(true);
  });

  it('waits for an admission already past the fence, and then counts the task it wrote', async () => {
    await admitTask();

    const draining = phaseDraining(context());
    await untilWaiting();
    expect(written).toEqual([]);

    proceed();
    await inFlight;
    await draining;

    expect(written).toEqual(['draining']);
    expect(logged).toContainEqual({ event: 'drain-forced', fields: { live: 1 } });
    expect(await fenceIsFree()).toBe(true);
  });
});
