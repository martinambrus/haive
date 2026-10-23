import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import { phaseDraining, phaseMaintenance, type UpgradeContext } from './run.js';

const FENCE = 'haive-new-work-fence';

interface Statement {
  kind: string;
  values: unknown[];
  connection: string;
}

const events: string[] = [];
const statements: Statement[] = [];
const logs: string[] = [];
const logFields: Record<string, unknown>[] = [];

function kindOf(text: string): string {
  if (/pg_advisory_unlock\(/.test(text)) return 'unlock';
  if (/pg_advisory_lock\(/.test(text)) return 'lock';
  if (/count\(\*\)/.test(text)) return 'count';
  if (/upgrade_runs/.test(text)) return 'journal';
  return text;
}

/** A pool: each plain statement gets a connection of its own, so only a reserved one holds a lock. */
function fakeSql(failOn?: string, live: number | (() => number) = 0) {
  let next = 0;
  const run =
    (connection: () => string) =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const kind = kindOf(strings.join('?').replace(/\s+/g, ' ').trim());
      if (statements.length > 200) return Promise.reject(new Error('runaway loop'));
      statements.push({ kind, values, connection: connection() });
      events.push(kind);
      if (kind === failOn) return Promise.reject(new Error(`${kind} failed`));
      return Promise.resolve(
        kind === 'count' ? [{ n: String(typeof live === 'function' ? live() : live) }] : [],
      );
    };
  return Object.assign(
    run(() => `pool-${(next += 1)}`),
    {
      reserve: async () =>
        Object.assign(
          run(() => 'reserved'),
          { release: () => undefined },
        ),
    },
  );
}

const context = (sql: ReturnType<typeof fakeSql>, over: Partial<UpgradeContext> = {}) =>
  ({
    sql,
    runId: 'run-1',
    drainDeadlineMs: 0,
    drainPollMs: 1,
    forceDrain: true,
    log: (event: string, fields?: Record<string, unknown>) => {
      logs.push(event);
      logFields.push({ event, ...fields });
    },
    ...over,
  }) as unknown as UpgradeContext;

const fenceEvents = () =>
  events.filter((e) => ['lock', 'unlock', 'count', 'get'].includes(e) || e.startsWith('set:'));
const held = (...inside: string[]) => ['lock', ...inside, 'unlock'];
const statement = (kind: string) => statements.find((s) => s.kind === kind);
const journalPhases = () => statements.filter((s) => s.kind === 'journal').map((s) => s.values[0]);
const stateWrites = () => events.filter((e) => e.startsWith('set:'));

let writeFails = false;
let stored = 'draining';

beforeEach(() => {
  events.length = 0;
  statements.length = 0;
  logs.length = 0;
  logFields.length = 0;
  writeFails = false;
  stored = 'draining';
  vi.spyOn(configService, 'set').mockImplementation(async (_key, value) => {
    events.push(`set:${value}`);
    if (writeFails) throw new Error('redis down');
    stored = value;
  });
  vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
    events.push('get');
    return stored;
  });
});

describe('phaseDraining', () => {
  it('reads the state and writes draining over normal while it holds the new-work fence, and counts after it let go', async () => {
    stored = 'normal';

    await phaseDraining(context(fakeSql()));

    expect(fenceEvents()).toEqual(['lock', 'get', 'set:draining', 'unlock', 'count']);
  });

  it.each(['draining', 'maintenance'])(
    'reads %s under the fence and writes nothing, and counts after it let go',
    async (found) => {
      stored = found;

      await phaseDraining(context(fakeSql()));

      expect(fenceEvents()).toEqual(['lock', 'get', 'unlock', 'count']);
      expect(stored).toBe(found);
    },
  );

  it.each(['normal', 'draining', 'maintenance'])(
    'logs the draining event with the deadline and the %s state it found',
    async (found) => {
      stored = found;

      await phaseDraining(context(fakeSql(), { drainDeadlineMs: 0 }));

      expect(logFields[0]).toEqual({ event: 'draining', deadlineMs: 0, found });
    },
  );

  it('waits for live work, and writes nothing, when an administrator chose maintenance and force was chosen', async () => {
    stored = 'maintenance';
    const ctx = context(fakeSql(undefined, 1));

    await phaseDraining(ctx);

    expect(stateWrites()).toEqual([]);
    expect(logFields).toContainEqual({ event: 'drain-forced', live: 1 });
    expect(ctx.drainForced).toBe(true);
  });

  it('gives up, and writes nothing, when an administrator chose maintenance, work is live and force was not chosen', async () => {
    stored = 'maintenance';
    const ctx = context(fakeSql(undefined, 1), { forceDrain: false, drainDeadlineMs: 0 });

    await expect(phaseDraining(ctx)).rejects.toThrow(
      '1 task(s) or background job(s) are still live',
    );

    expect(stateWrites()).toEqual([]);
    expect(stored).toBe('maintenance');
  });

  it('keeps maintenance through the draining and maintenance phases when nothing is live', async () => {
    stored = 'maintenance';
    const ctx = context(fakeSql(), { forceDrain: false });

    await phaseDraining(ctx);
    await phaseMaintenance(ctx);

    expect(stateWrites()).toEqual([]);
    expect(stored).toBe('maintenance');
    expect(logs).toEqual(['draining', 'drained', 'maintenance']);
  });

  it('still writes draining once over normal', async () => {
    stored = 'normal';
    const ctx = context(fakeSql(), { forceDrain: false });

    await phaseDraining(ctx);

    expect(stateWrites()).toEqual(['set:draining']);
  });

  it('takes and releases the fence on one session, on the one key an admission shares', async () => {
    await phaseDraining(context(fakeSql()));

    const lock = statement('lock');
    const unlock = statement('unlock');
    expect(lock?.values).toEqual([FENCE]);
    expect(unlock?.values).toEqual([FENCE]);
    expect(unlock?.connection).toBe(lock?.connection);
  });

  it('lets the fence go when the write throws, and counts nothing', async () => {
    stored = 'normal';
    writeFails = true;

    await expect(phaseDraining(context(fakeSql()))).rejects.toThrow('redis down');

    expect(fenceEvents()).toEqual(['lock', 'get', 'set:draining', 'unlock']);
  });

  it('lets the fence go when the read throws, and writes and counts nothing', async () => {
    stored = 'normal';
    vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
      events.push('get');
      throw new Error('redis down');
    });

    await expect(phaseDraining(context(fakeSql()))).rejects.toThrow('redis down');

    expect(fenceEvents()).toEqual(['lock', 'get', 'unlock']);
  });

  it('reads and writes nothing when the fence cannot be taken', async () => {
    await expect(phaseDraining(context(fakeSql('lock')))).rejects.toThrow('lock failed');

    expect(fenceEvents()).toEqual(['lock']);
  });

  it('records that it went past live work, for the maintenance phase', async () => {
    const forced = context(fakeSql(undefined, 2));
    const drained = context(fakeSql());

    await phaseDraining(forced);
    await phaseDraining(drained);

    expect(forced.drainForced).toBe(true);
    expect(drained.drainForced).toBe(false);
  });
});

describe('phaseMaintenance', () => {
  it('recounts and writes maintenance on the one session that holds the new-work fence', async () => {
    await phaseMaintenance(context(fakeSql()));

    expect(fenceEvents()).toEqual(['lock', 'get', 'count', 'set:maintenance', 'unlock']);
    expect(statement('count')?.connection).toBe(statement('lock')?.connection);
    expect(statement('unlock')?.connection).toBe(statement('lock')?.connection);
  });

  it('lets the fence go when the write throws', async () => {
    writeFails = true;

    await expect(phaseMaintenance(context(fakeSql()))).rejects.toThrow('redis down');

    expect(fenceEvents()).toEqual(['lock', 'get', 'count', 'set:maintenance', 'unlock']);
  });

  it('writes nothing when the fence cannot be taken', async () => {
    await expect(phaseMaintenance(context(fakeSql('lock')))).rejects.toThrow('lock failed');

    expect(fenceEvents()).toEqual(['lock']);
  });

  it('leaves draining as it is, and waits again, when a task is live under the fence', async () => {
    const ctx = context(fakeSql(undefined, 1), { forceDrain: false });

    await expect(phaseMaintenance(ctx)).rejects.toThrow(
      '1 task(s) or background job(s) are still live',
    );

    expect(fenceEvents()).toEqual(['lock', 'get', 'count', 'unlock', 'count']);
    expect(logs).toEqual(['drain-reopened']);
  });

  it('writes draining again, not maintenance, when normal was chosen and a task is live under the fence', async () => {
    stored = 'normal';
    const ctx = context(fakeSql(undefined, 1), { forceDrain: false });

    await expect(phaseMaintenance(ctx)).rejects.toThrow(
      '1 task(s) or background job(s) are still live',
    );

    expect(fenceEvents()).toEqual(['lock', 'get', 'count', 'set:draining', 'unlock', 'count']);
    expect(logs).toEqual(['drain-reopened']);
  });

  it('writes draining again, then maintenance, when an administrator changed the state', async () => {
    stored = 'normal';

    await phaseMaintenance(context(fakeSql(), { drainDeadlineMs: 60_000 }));

    expect(fenceEvents()).toEqual([
      ...held('get', 'count', 'set:draining'),
      'count',
      ...held('get', 'count', 'set:maintenance'),
    ]);
    expect(logs).toEqual(['drain-reopened', 'drained', 'maintenance']);
  });

  it('forces past a task that is still live when the second wait ends, with force chosen', async () => {
    await phaseMaintenance(context(fakeSql(undefined, 1)));

    expect(fenceEvents()).toEqual([...held('get', 'count'), 'count', ...held('set:maintenance')]);
    expect(logs).toEqual(['drain-reopened', 'drain-forced', 'maintenance']);
  });

  it('writes maintenance without a recount when the drain was forced', async () => {
    await phaseMaintenance(context(fakeSql(undefined, 3), { drainForced: true }));

    expect(fenceEvents()).toEqual(['lock', 'set:maintenance', 'unlock']);
    expect(statement('unlock')?.connection).toBe(statement('lock')?.connection);
  });
});

describe('an administrator who chose maintenance during the drain', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets maintenance enter, writing nothing, when nothing is live', async () => {
    stored = 'maintenance';

    await phaseMaintenance(context(fakeSql(), { forceDrain: false }));

    expect(fenceEvents()).toEqual(held('get', 'count'));
    expect(logs).toEqual(['maintenance']);
  });

  it('is never relaxed to draining while a task is live, and enters without a write once it ends', async () => {
    vi.useFakeTimers();
    stored = 'maintenance';
    let counts = 0;
    const ctx = context(
      fakeSql(undefined, () => (counts++ < 2 ? 1 : 0)),
      { drainDeadlineMs: 60_000, forceDrain: false },
    );

    const entering = phaseMaintenance(ctx);
    await vi.advanceTimersByTimeAsync(20_000);
    await entering;

    expect(stateWrites()).toEqual([]);
    expect(stored).toBe('maintenance');
    expect(logs).toEqual(['drain-reopened', 'drained', 'maintenance']);
  });
});

describe('the upgrade journal', () => {
  it('records the maintenance phase once when the first recount enters', async () => {
    await phaseMaintenance(context(fakeSql()));

    expect(journalPhases()).toEqual(['maintenance']);
  });

  it('records the draining phase for a wait, and maintenance again when it finally enters', async () => {
    stored = 'normal';

    await phaseMaintenance(context(fakeSql()));

    expect(journalPhases()).toEqual(['maintenance', 'draining', 'maintenance']);
  });

  it('records the maintenance phase when the second wait ends in a force', async () => {
    await phaseMaintenance(context(fakeSql(undefined, 1)));

    expect(journalPhases()).toEqual(['maintenance', 'draining', 'maintenance']);
  });

  it('leaves the draining phase as its last word when the second wait gives up', async () => {
    const ctx = context(fakeSql(undefined, 1), { forceDrain: false });

    await expect(phaseMaintenance(ctx)).rejects.toThrow(
      '1 task(s) or background job(s) are still live',
    );

    expect(journalPhases()).toEqual(['maintenance', 'draining']);
  });

  it('records the maintenance phase once, with no wait, when the drain was forced', async () => {
    await phaseMaintenance(context(fakeSql(undefined, 3), { drainForced: true }));

    expect(journalPhases()).toEqual(['maintenance']);
  });
});

describe('the drain wait, on a clock', () => {
  const DEADLINE_MS = 30_000;
  const POLL_MS = 1_000;
  let taskEndsAt: number;
  let races: number;
  const liveWhileTask = () => (Date.now() < taskEndsAt ? 1 : 0);

  beforeEach(() => {
    vi.useFakeTimers();
    taskEndsAt = 0;
    races = 0;
    let drainRead = false;
    // Three times in a row an administrator chose normal and a task was admitted after the count.
    vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
      events.push('get');
      if (!drainRead) {
        drainRead = true;
        return 'normal';
      }
      if (races >= 3) return stored;
      races += 1;
      taskEndsAt = Date.now() + 12_000;
      return 'normal';
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const timed = async (ctx: UpgradeContext) => {
    const start = Date.now();
    await phaseDraining(ctx);
    let took = 0;
    const ended = phaseMaintenance(ctx).then(
      () => 'entered',
      (err: Error) => err.message,
    );
    void ended.then(() => (took = Date.now() - start));
    await vi.advanceTimersByTimeAsync(2 * DEADLINE_MS);
    return { outcome: await ended, took };
  };

  it('gives up one deadline after the first wait, not one deadline after each reopening', async () => {
    const ctx = context(fakeSql(undefined, liveWhileTask), {
      drainDeadlineMs: DEADLINE_MS,
      drainPollMs: POLL_MS,
      forceDrain: false,
    });

    const { outcome, took } = await timed(ctx);

    expect(outcome).toContain('task(s) or background job(s) are still live');
    expect(took).toBeLessThanOrEqual(DEADLINE_MS + POLL_MS);
  });

  it('forces one deadline after the first wait, not one deadline after each reopening, with force chosen', async () => {
    const ctx = context(fakeSql(undefined, liveWhileTask), {
      drainDeadlineMs: DEADLINE_MS,
      drainPollMs: POLL_MS,
      forceDrain: true,
    });

    const { outcome, took } = await timed(ctx);

    expect(outcome).toBe('entered');
    expect(logs).toContain('drain-forced');
    expect(took).toBeLessThanOrEqual(DEADLINE_MS + POLL_MS);
  });

  describe('a state that keeps being reopened with nothing live', () => {
    const REOPENED_DEADLINE_MS = 10_000;

    beforeEach(() => {
      vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
        events.push('get');
        return 'normal';
      });
    });

    it('gives up at the one deadline', async () => {
      const ctx = context(fakeSql(), {
        drainDeadlineMs: REOPENED_DEADLINE_MS,
        drainPollMs: POLL_MS,
        forceDrain: false,
      });

      const { outcome, took } = await timed(ctx);

      expect(outcome).toContain('Admissions were reopened after 10s');
      expect(took).toBeLessThanOrEqual(REOPENED_DEADLINE_MS + POLL_MS);
    });

    it('enters maintenance at the one deadline with force chosen', async () => {
      const ctx = context(fakeSql(), {
        drainDeadlineMs: REOPENED_DEADLINE_MS,
        drainPollMs: POLL_MS,
        forceDrain: true,
      });

      const { outcome, took } = await timed(ctx);

      expect(outcome).toBe('entered');
      expect(logs).toContain('drain-forced');
      expect(stateWrites().at(-1)).toBe('set:maintenance');
      expect(took).toBeLessThanOrEqual(REOPENED_DEADLINE_MS + POLL_MS);
    });
  });

  it('recounts no faster than once per poll interval while the state keeps being rewritten with nothing live', async () => {
    const WINDOW_MS = 1_000;
    const interval = 100;
    let rewriting = true;
    vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
      events.push('get');
      return rewriting ? 'normal' : stored;
    });
    const ctx = context(fakeSql(), {
      drainDeadlineMs: DEADLINE_MS,
      drainPollMs: interval,
      forceDrain: false,
    });

    const ended = phaseMaintenance(ctx).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    const recounts = statements.filter((s) => s.kind === 'lock').length;
    rewriting = false;
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    await ended;

    expect(recounts).toBeLessThanOrEqual(WINDOW_MS / interval + 1);
    expect(recounts).toBeGreaterThanOrEqual(WINDOW_MS / interval);
  });

  it('counts again after the poll interval the context names', async () => {
    let counts = 0;
    const ctx = context(
      fakeSql(undefined, () => (++counts === 1 ? 1 : 0)),
      { drainDeadlineMs: DEADLINE_MS, drainPollMs: 200, forceDrain: false },
    );

    const waiting = phaseDraining(ctx);
    await vi.advanceTimersByTimeAsync(199);
    expect(counts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(counts).toBe(2);
    await waiting;
  });

  it('counts again after 5 s when the context names no poll interval', async () => {
    let counts = 0;
    const ctx = context(
      fakeSql(undefined, () => (++counts === 1 ? 1 : 0)),
      { drainDeadlineMs: DEADLINE_MS, drainPollMs: undefined, forceDrain: false },
    );

    const waiting = phaseDraining(ctx);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(counts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(counts).toBe(2);
    await waiting;
  });
});
