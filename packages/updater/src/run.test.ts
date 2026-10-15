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

function kindOf(text: string): string {
  if (/pg_advisory_unlock\(/.test(text)) return 'unlock';
  if (/pg_advisory_lock\(/.test(text)) return 'lock';
  if (/count\(\*\)/.test(text)) return 'count';
  if (/upgrade_runs/.test(text)) return 'journal';
  return text;
}

/** A pool: each plain statement gets a connection of its own, so only a reserved one holds a lock. */
function fakeSql(failOn?: string) {
  let next = 0;
  const run =
    (connection: () => string) =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const kind = kindOf(strings.join('?').replace(/\s+/g, ' ').trim());
      statements.push({ kind, values, connection: connection() });
      events.push(kind);
      if (kind === failOn) return Promise.reject(new Error(`${kind} failed`));
      return Promise.resolve(kind === 'count' ? [{ n: '0' }] : []);
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

const context = (sql: ReturnType<typeof fakeSql>) =>
  ({
    sql,
    runId: 'run-1',
    drainDeadlineMs: 0,
    forceDrain: true,
    log: () => undefined,
  }) as unknown as UpgradeContext;

const fenceEvents = () =>
  events.filter((e) => ['lock', 'unlock', 'count'].includes(e) || e.startsWith('set:'));
const statement = (kind: string) => statements.find((s) => s.kind === kind);

let writeFails = false;

beforeEach(() => {
  events.length = 0;
  statements.length = 0;
  writeFails = false;
  vi.spyOn(configService, 'set').mockImplementation(async (_key, value) => {
    events.push(`set:${value}`);
    if (writeFails) throw new Error('redis down');
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
});

describe('phaseMaintenance', () => {
  it('writes the maintenance state while it holds the new-work fence', async () => {
    await phaseMaintenance(context(fakeSql()));

    expect(fenceEvents()).toEqual(['lock', 'set:maintenance', 'unlock']);
    expect(statement('unlock')?.connection).toBe(statement('lock')?.connection);
  });

  it('lets the fence go when the write throws', async () => {
    writeFails = true;

    await expect(phaseMaintenance(context(fakeSql()))).rejects.toThrow('redis down');

    expect(fenceEvents()).toEqual(['lock', 'set:maintenance', 'unlock']);
  });
});
