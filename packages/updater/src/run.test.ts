import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function kindOf(text: string): string {
  if (/pg_advisory_unlock\(/.test(text)) return 'unlock';
  if (/pg_advisory_lock\(/.test(text)) return 'lock';
  if (/count\(\*\)/.test(text)) return 'count';
  if (/upgrade_runs/.test(text)) return 'journal';
  return text;
}

/** A pool: each plain statement gets a connection of its own, so only a reserved one holds a lock. */
function fakeSql(failOn?: string, live = 0) {
  let next = 0;
  const run =
    (connection: () => string) =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const kind = kindOf(strings.join('?').replace(/\s+/g, ' ').trim());
      if (statements.length > 200) return Promise.reject(new Error('runaway loop'));
      statements.push({ kind, values, connection: connection() });
      events.push(kind);
      if (kind === failOn) return Promise.reject(new Error(`${kind} failed`));
      return Promise.resolve(kind === 'count' ? [{ n: String(live) }] : []);
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
    forceDrain: true,
    log: (event: string) => logs.push(event),
    ...over,
  }) as unknown as UpgradeContext;

const fenceEvents = () =>
  events.filter((e) => ['lock', 'unlock', 'count', 'get'].includes(e) || e.startsWith('set:'));
const held = (...inside: string[]) => ['lock', ...inside, 'unlock'];
const statement = (kind: string) => statements.find((s) => s.kind === kind);

let writeFails = false;
let stored = 'draining';

beforeEach(() => {
  events.length = 0;
  statements.length = 0;
  logs.length = 0;
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
  it('writes the draining state while it holds the new-work fence, and counts after it let go', async () => {
    await phaseDraining(context(fakeSql()));

    expect(fenceEvents()).toEqual(['lock', 'set:draining', 'unlock', 'count']);
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
    writeFails = true;

    await expect(phaseDraining(context(fakeSql()))).rejects.toThrow('redis down');

    expect(fenceEvents()).toEqual(['lock', 'set:draining', 'unlock']);
  });

  it('writes nothing when the fence cannot be taken', async () => {
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

  it('writes draining again, not maintenance, when a task is live under the fence', async () => {
    const ctx = context(fakeSql(undefined, 1), { forceDrain: false });

    await expect(phaseMaintenance(ctx)).rejects.toThrow('1 task(s) are still live');

    expect(fenceEvents()).toEqual(['lock', 'get', 'count', 'set:draining', 'unlock', 'count']);
    expect(logs).toEqual(['drain-reopened']);
  });

  it('writes draining again, then maintenance, when an administrator changed the state', async () => {
    stored = 'normal';

    await phaseMaintenance(context(fakeSql()));

    expect(fenceEvents()).toEqual([
      ...held('get', 'count', 'set:draining'),
      'count',
      ...held('get', 'count', 'set:maintenance'),
    ]);
    expect(logs).toEqual(['drain-reopened', 'drained', 'maintenance']);
  });

  it('forces past a task that is still live when the second wait ends, with force chosen', async () => {
    await phaseMaintenance(context(fakeSql(undefined, 1)));

    expect(fenceEvents()).toEqual([
      ...held('get', 'count', 'set:draining'),
      'count',
      ...held('set:maintenance'),
    ]);
    expect(logs).toEqual(['drain-reopened', 'drain-forced', 'maintenance']);
  });

  it('writes maintenance without a recount when the drain was forced', async () => {
    await phaseMaintenance(context(fakeSql(undefined, 3), { drainForced: true }));

    expect(fenceEvents()).toEqual(['lock', 'set:maintenance', 'unlock']);
    expect(statement('unlock')?.connection).toBe(statement('lock')?.connection);
  });
});
