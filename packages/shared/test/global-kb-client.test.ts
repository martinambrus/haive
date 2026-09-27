import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensure: vi.fn<(conn: { pg: object }) => Promise<unknown>>(),
  log: [] as string[],
}));

vi.mock('../src/global-kb/connection.js', () => ({
  resolveGlobalKbSettings: async () => ({}),
  resolveGlobalKbConnection: async () => {
    const tx = Object.assign(
      (strings: TemplateStringsArray) => {
        h.log.push(strings.join('$'));
        return Promise.resolve([]);
      },
      { savepoint: async () => undefined },
    );
    const begin = async (fn: (sql: typeof tx) => Promise<unknown>) => {
      h.log.push('begin');
      try {
        const result = await fn(tx);
        h.log.push('commit');
        return result;
      } catch (err) {
        h.log.push('rollback');
        throw err;
      }
    };
    const pg = Object.assign(() => Promise.resolve([]), { begin });
    return { pg, embeddingDimensions: 8, close: async () => {} };
  },
}));
vi.mock('../src/global-kb/ensure-schema.js', () => ({ ensureGlobalKbSchema: h.ensure }));
vi.mock('../src/global-kb/schema.js', () => ({ createGlobalKbDb: () => ({}) }));

/** A fresh module each time: the ensure is remembered per process, i.e. per module instance. */
async function load() {
  vi.resetModules();
  return (await import('../src/global-kb/client.js')).withGlobalKb;
}

const haiveDb = {} as Parameters<Awaited<ReturnType<typeof load>>>[0];

beforeEach(() => {
  h.ensure.mockReset();
  h.log.length = 0;
});

describe('withGlobalKb', () => {
  it('runs one schema ensure for concurrent first calls, and none after', async () => {
    let finish!: () => void;
    h.ensure.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const withGlobalKb = await load();
    const ran: string[] = [];

    const first = withGlobalKb(haiveDb, async () => void ran.push('first'));
    const second = withGlobalKb(haiveDb, async () => void ran.push('second'));
    await vi.waitFor(() => expect(h.ensure).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(ran).toEqual([]);

    finish();
    await Promise.all([first, second]);
    await withGlobalKb(haiveDb, async () => void ran.push('later'));
    expect(ran.sort()).toEqual(['first', 'later', 'second']);
    expect(h.ensure).toHaveBeenCalledTimes(1);
  });

  it('ensures in one transaction, under the lock that transaction holds', async () => {
    h.ensure.mockImplementation(async (conn) => {
      h.log.push(`ensure ${'savepoint' in conn.pg ? 'in the transaction' : 'outside it'}`);
    });
    const withGlobalKb = await load();

    await withGlobalKb(haiveDb, async () => undefined);
    expect(h.log).toEqual([
      'begin',
      'SELECT pg_advisory_xact_lock(hashtext($))',
      'ensure in the transaction',
      'commit',
    ]);
  });

  it('rolls a failed ensure back, and tries again on the next call', async () => {
    h.ensure.mockRejectedValueOnce(new Error('ensure failed')).mockResolvedValueOnce(undefined);
    const withGlobalKb = await load();

    await expect(withGlobalKb(haiveDb, async () => undefined)).rejects.toThrow('ensure failed');
    expect(h.log).toEqual(['begin', 'SELECT pg_advisory_xact_lock(hashtext($))', 'rollback']);
    await withGlobalKb(haiveDb, async () => undefined);
    expect(h.ensure).toHaveBeenCalledTimes(2);
  });
});
