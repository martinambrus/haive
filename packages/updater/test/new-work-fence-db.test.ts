import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import { ensureJournal, finishRun, startRun } from '../src/journal.js';
import {
  phaseCommit,
  phaseDraining,
  phaseMaintenance,
  rollback,
  type UpgradeContext,
} from '../src/run.js';

vi.mock('../src/docker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker.js')>()),
  composeUp: async () => undefined,
  runOneShot: async () => 'migrated',
}));

const url = process.env.UPDATER_FENCE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/updater_fence_test'))
  throw new Error('Use a dedicated updater_fence_test database for the new-work fence tests');

const OWNER = '00000000-0000-4000-8000-0000000000f7';
const BLIND_INDEX = 'updater-fence-test-owner';
const TYPE = 'updater-fence-test';
const FENCE = 'haive-new-work-fence';

describe.skipIf(!url)('the new-work fence, taken by the updater, on Postgres', () => {
  let updater: Sql;
  let admission: Sql;
  let admin: Sql;
  let probe: Sql;
  let holder: Awaited<ReturnType<Sql['reserve']>> | undefined;
  let runId: string;
  let stored: string;
  let written: string[];
  let logged: { event: string; fields?: Record<string, unknown> }[];
  let proceed: () => void;
  let inFlight: Promise<unknown> | undefined;
  let updating: Promise<unknown> | undefined;
  let settled: boolean;

  const context = () =>
    ({
      sql: updater,
      runId,
      drainDeadlineMs: 0,
      drainPollMs: 25,
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

  /** An administrator's PUT /admin/maintenance: its transaction holds the fence exclusively. */
  const holdFence = async () => {
    holder = await admin.reserve();
    await holder`SELECT pg_advisory_lock(hashtextextended(${FENCE}, 0))`;
  };

  const releaseFence = async () => {
    if (!holder) return;
    await holder`SELECT pg_advisory_unlock(hashtextextended(${FENCE}, 0))`;
    holder.release();
    holder = undefined;
  };

  const untilWaiting = async () => {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const [row] = await probe<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock'
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      if (row && row.n > 0) return;
      if (Date.now() > deadline) throw new Error('the updater never waited for the new-work fence');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const until = async (done: () => boolean, what: string) => {
    const deadline = Date.now() + 3_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`never saw ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const journalPhase = async () => {
    const [row] = await probe<{ phase: string }[]>`
      SELECT phase FROM upgrade_runs WHERE id = ${runId}`;
    return row?.phase;
  };

  const untilPhase = async (phase: string) => {
    const deadline = Date.now() + 3_000;
    while ((await journalPhase()) !== phase) {
      if (Date.now() > deadline) throw new Error(`the journal never said ${phase}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const fenceIsFree = async () => {
    const [row] = await probe<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${FENCE}, 0)) AS locked`;
    if (row?.locked) await probe`SELECT pg_advisory_unlock(hashtextextended(${FENCE}, 0))`;
    return row?.locked === true;
  };

  const liveTask = () =>
    probe`INSERT INTO tasks (user_id, type, title, status)
          VALUES (${OWNER}, ${TYPE}, 'Task', 'running')`;

  const endTasks = () => probe`UPDATE tasks SET status = 'completed' WHERE type = ${TYPE}`;

  beforeAll(async () => {
    updater = postgres(url as string, { max: 1, max_lifetime: 0 });
    admission = postgres(url as string, { max: 1 });
    admin = postgres(url as string, { max: 1, max_lifetime: 0 });
    probe = postgres(url as string, { max: 1 });
    await ensureJournal(updater);
    await updater`DELETE FROM users WHERE email_blind_index = ${BLIND_INDEX}`;
    await updater`INSERT INTO users (id, email_encrypted, email_blind_index, password_hash)
                  VALUES (${OWNER}, 'not-real', ${BLIND_INDEX}, 'not-real')`;
  });

  beforeEach(async () => {
    stored = 'normal';
    written = [];
    logged = [];
    inFlight = undefined;
    updating = undefined;
    await updater`DELETE FROM tasks WHERE type = ${TYPE}`;
    runId = await startRun(updater, {
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      channel: 'public',
    });
    vi.spyOn(configService, 'set').mockImplementation(async (_key, value) => {
      written.push(value);
      stored = value;
    });
    vi.spyOn(configService, 'getFresh').mockImplementation(async () => stored);
  });

  afterEach(async () => {
    proceed?.();
    await releaseFence();
    await inFlight?.catch(() => undefined);
    await endTasks();
    await updating?.catch(() => undefined);
    await finishRun(updater, runId, 'rolled_back');
  });

  afterAll(async () => {
    await updater`DELETE FROM users WHERE email_blind_index = ${BLIND_INDEX}`;
    await updater.end({ timeout: 5 });
    await admission.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
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

  describe('the maintenance transition', () => {
    const upgrade = (over: Partial<UpgradeContext> = {}) =>
      ({ ...context(), drainDeadlineMs: 60_000, forceDrain: false, ...over }) as UpgradeContext;

    const enter = (ctx: UpgradeContext) => {
      settled = false;
      updating = phaseMaintenance(ctx);
      updating.then(
        () => (settled = true),
        () => (settled = true),
      );
      return updating;
    };

    it('reads the state and writes maintenance once, under the fence, when draining with nothing live', async () => {
      stored = 'draining';
      const heldAt: string[] = [];
      const holdsFence = async (what: string) => {
        if (!(await fenceIsFree())) heldAt.push(what);
      };
      vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
        await holdsFence('read');
        return stored;
      });
      vi.spyOn(configService, 'set').mockImplementation(async (_key, value) => {
        await holdsFence('write');
        written.push(value);
        stored = value;
      });

      await enter(upgrade());

      expect(heldAt).toEqual(['read', 'write']);
      expect(written).toEqual(['maintenance']);
      expect(logged.map((l) => l.event)).toEqual(['maintenance']);
      expect(await fenceIsFree()).toBe(true);
    });

    it('waits for an admission already past the fence, and then counts the task it wrote', async () => {
      stored = 'draining';
      await admitTask();

      const entering = enter(upgrade({ drainDeadlineMs: 0 }));
      await untilWaiting();
      expect(written).toEqual([]);

      proceed();
      await inFlight;
      await expect(entering).rejects.toThrow('1 task(s) are still live');

      expect(written).toEqual([]);
      expect(await fenceIsFree()).toBe(true);
    });

    it('goes back to the drain wait, not maintenance, when normal was chosen and an admission committed after the count', async () => {
      const ctx = upgrade();
      await phaseDraining(ctx);
      expect(written).toEqual(['draining']);

      stored = 'normal';
      await admitTask();
      proceed();
      await inFlight;

      enter(ctx);
      await until(
        () => settled || logged.some((l) => l.event === 'drain-reopened'),
        'the drain to reopen',
      );
      expect(written).toEqual(['draining', 'draining']);
      expect(logged).toContainEqual({
        event: 'drain-reopened',
        fields: { state: 'normal', live: 1 },
      });
      expect(settled).toBe(false);
      expect(await fenceIsFree()).toBe(true);

      await endTasks();
      await updating;

      expect(written).toEqual(['draining', 'draining', 'maintenance']);
      expect(logged.at(-1)?.event).toBe('maintenance');
      expect(await fenceIsFree()).toBe(true);
    });

    it('writes draining again, then maintenance once, when an administrator chose normal and no task came', async () => {
      stored = 'normal';

      await enter(upgrade());

      expect(written).toEqual(['draining', 'maintenance']);
      expect(logged).toEqual([
        { event: 'drain-reopened', fields: { state: 'normal', live: 0 } },
        { event: 'drained', fields: { live: 0 } },
        { event: 'maintenance' },
      ]);
      expect(await fenceIsFree()).toBe(true);
    });

    it('enters without writing draining, or anything, when an administrator chose maintenance and no task is live', async () => {
      stored = 'maintenance';

      await enter(upgrade());

      expect(written).toEqual([]);
      expect(stored).toBe('maintenance');
      expect(logged).toEqual([{ event: 'maintenance' }]);
      expect(await fenceIsFree()).toBe(true);
    });

    it('waits for a live task without writing draining when an administrator chose maintenance, and then enters without a write', async () => {
      stored = 'maintenance';
      await liveTask();

      enter(upgrade());
      await until(
        () => settled || logged.some((l) => l.event === 'drain-reopened'),
        'the drain to reopen',
      );
      expect(logged).toContainEqual({
        event: 'drain-reopened',
        fields: { state: 'maintenance', live: 1 },
      });
      expect(written).toEqual([]);
      expect(stored).toBe('maintenance');
      expect(settled).toBe(false);

      await endTasks();
      await updating;

      expect(written).toEqual([]);
      expect(logged.map((l) => l.event)).toEqual(['drain-reopened', 'drained', 'maintenance']);
      expect(await fenceIsFree()).toBe(true);
    });

    it('records the draining phase while it waits again, and the maintenance phase once it enters', async () => {
      stored = 'normal';
      await liveTask();

      enter(upgrade());
      await untilPhase('draining');
      expect(settled).toBe(false);

      await endTasks();
      await updating;

      expect(await journalPhase()).toBe('maintenance');
    });

    it('recounts no faster than once per poll interval while the state keeps being rewritten with nothing live', async () => {
      const interval = 100;
      const recountAt: number[] = [];
      vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
        recountAt.push(Date.now());
        return recountAt.length < 4 ? 'normal' : stored;
      });

      await enter(upgrade({ drainPollMs: interval }));

      const gaps = recountAt.slice(1).map((at, i) => at - (recountAt[i] ?? at));
      expect(gaps).toHaveLength(3);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(interval * 0.9);
      expect(written).toEqual(['draining', 'draining', 'draining', 'maintenance']);
    });

    it('still enters maintenance past a live task, without a second wait, when the drain was forced', async () => {
      await liveTask();
      const ctx = upgrade({ drainDeadlineMs: 0, forceDrain: true });
      await phaseDraining(ctx);

      await enter(ctx);

      expect(written).toEqual(['draining', 'maintenance']);
      expect(logged.map((l) => l.event)).toEqual(['draining', 'drain-forced', 'maintenance']);
      expect(await fenceIsFree()).toBe(true);
    });
  });

  describe.each([
    {
      name: 'the rollback',
      run: (ctx: UpgradeContext) => rollback(ctx, 'the new containers never reported the version'),
      finished: 'rolled-back',
    },
    { name: 'the commit', run: phaseCommit, finished: 'done' },
  ])('$name', ({ run, finished }) => {
    let envDir: string;

    // A spy cannot reach setEnvVar, a local binding of run.ts, so it writes a file of its own.
    const upgrade = () =>
      ({
        ...context(),
        envFile: join(envDir, '.env'),
        fromVersion: '1.0.0',
        target: { version: '1.1.0' },
        registry: 'registry.test',
        network: 'network.test',
      }) as unknown as UpgradeContext;

    beforeEach(async () => {
      envDir = await mkdtemp(join(tmpdir(), 'updater-fence-'));
      await writeFile(join(envDir, '.env'), 'HAIVE_VERSION=1.1.0\n');
    });

    afterEach(async () => {
      await rm(envDir, { recursive: true, force: true });
    });

    it('writes normal at once when no administrator holds the fence, and lets the fence go', async () => {
      await run(upgrade());

      expect(written).toEqual(['normal']);
      expect(logged.at(-1)?.event).toBe(finished);
      expect(await fenceIsFree()).toBe(true);
    });

    it('waits for an administrator holding the fence, and then writes normal once', async () => {
      await holdFence();

      updating = run(upgrade());
      await untilWaiting();
      expect(written).toEqual([]);

      await releaseFence();
      await updating;

      expect(written).toEqual(['normal']);
      expect(logged.at(-1)?.event).toBe(finished);
      expect(await fenceIsFree()).toBe(true);
    });
  });
});
