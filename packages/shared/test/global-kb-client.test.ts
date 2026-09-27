import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalKbConnection } from '../src/global-kb/connection.js';

const h = vi.hoisted(() => ({
  ensure: vi.fn<(conn: GlobalKbConnection) => Promise<unknown>>(),
  log: [] as string[],
}));

vi.mock('../src/global-kb/connection.js', () => ({
  resolveGlobalKbSettings: async () => ({}),
  resolveGlobalKbConnection: async () => {
    const reserved = Object.assign(
      (strings: TemplateStringsArray) => {
        h.log.push(strings.join('$'));
        return Promise.resolve([]);
      },
      { release: () => h.log.push('release') },
    );
    const pg = Object.assign(() => Promise.resolve([]), { reserve: async () => reserved });
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

  it('ensures under a session lock, on the one connection that holds it', async () => {
    h.ensure.mockImplementation(async (conn) => {
      h.log.push(`ensure on ${'release' in conn.pg ? 'the reserved connection' : 'the pool'}`);
    });
    const withGlobalKb = await load();

    await withGlobalKb(haiveDb, async () => undefined);
    expect(h.log).toEqual([
      'SELECT pg_advisory_lock(hashtext($))',
      'ensure on the reserved connection',
      'SELECT pg_advisory_unlock(hashtext($))',
      'release',
    ]);
  });

  it('lets go of the lock when the ensure fails, and tries again on the next call', async () => {
    h.ensure.mockRejectedValueOnce(new Error('ensure failed')).mockResolvedValueOnce(undefined);
    const withGlobalKb = await load();

    await expect(withGlobalKb(haiveDb, async () => undefined)).rejects.toThrow('ensure failed');
    expect(h.log).toEqual([
      'SELECT pg_advisory_lock(hashtext($))',
      'SELECT pg_advisory_unlock(hashtext($))',
      'release',
    ]);
    await withGlobalKb(haiveDb, async () => undefined);
    expect(h.ensure).toHaveBeenCalledTimes(2);
  });
});
