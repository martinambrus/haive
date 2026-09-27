import { beforeEach, describe, expect, it, vi } from 'vitest';

type Store = { mode: 'internal' | 'external'; connectionString: string | null };

const h = vi.hoisted(() => ({
  ensure: vi.fn<(conn: { store: string }) => Promise<unknown>>(),
  settings: { mode: 'internal', connectionString: null } as Store,
}));

vi.mock('../src/global-kb/connection.js', () => ({
  resolveGlobalKbSettings: async () => ({ ...h.settings }),
  resolveGlobalKbConnection: async (settings: Store) => ({
    store: settings.connectionString ?? settings.mode,
    pg: () => Promise.resolve([]),
    embeddingDimensions: 8,
    close: async () => {},
  }),
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
  h.settings = { mode: 'internal', connectionString: null };
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

  it('tries a failed ensure again on the next call', async () => {
    h.ensure.mockRejectedValueOnce(new Error('ensure failed')).mockResolvedValueOnce(undefined);
    const withGlobalKb = await load();

    await expect(withGlobalKb(haiveDb, async () => undefined)).rejects.toThrow('ensure failed');
    await withGlobalKb(haiveDb, async () => undefined);
    expect(h.ensure).toHaveBeenCalledTimes(2);
  });

  it("ensures a store switched to while another store's ensure is in flight", async () => {
    const finish: Record<string, () => void> = {};
    h.ensure.mockImplementation(
      (conn) => new Promise<void>((resolve) => (finish[conn.store] = resolve)),
    );
    const withGlobalKb = await load();
    const ran: string[] = [];

    const internal = withGlobalKb(haiveDb, async () => void ran.push('internal'));
    await vi.waitFor(() => expect(finish.internal).toBeDefined());
    h.settings = { mode: 'external', connectionString: 'postgres://kb.example/one' };
    const external = withGlobalKb(haiveDb, async () => void ran.push('external'));
    finish.internal!();
    await internal;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ran).toEqual(['internal']);
    expect(h.ensure.mock.calls.map(([conn]) => conn.store)).toEqual([
      'internal',
      'postgres://kb.example/one',
    ]);
    finish['postgres://kb.example/one']!();
    await external;
    expect(ran).toEqual(['internal', 'external']);
  });

  it('ensures a store switched to after the first one was ensured, once', async () => {
    h.ensure.mockResolvedValue(undefined);
    const withGlobalKb = await load();

    await withGlobalKb(haiveDb, async () => undefined);
    h.settings = { mode: 'external', connectionString: 'postgres://kb.example/one' };
    await withGlobalKb(haiveDb, async () => undefined);
    await withGlobalKb(haiveDb, async () => undefined);
    h.settings = { mode: 'internal', connectionString: null };
    await withGlobalKb(haiveDb, async () => undefined);

    expect(h.ensure.mock.calls.map(([conn]) => conn.store)).toEqual([
      'internal',
      'postgres://kb.example/one',
    ]);
  });
});
