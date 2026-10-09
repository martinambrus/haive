import { beforeEach, describe, expect, it, vi } from 'vitest';

type Store = { mode: 'internal' | 'external'; connectionString: string | null };

const h = vi.hoisted(() => ({
  ensure: vi.fn<(conn: { store: string }) => Promise<unknown>>(),
  settings: { mode: 'internal', connectionString: null } as Store,
  connectOpts: [] as unknown[],
  connectDelayMs: 0,
  ends: [] as unknown[],
  closes: 0,
  onEnd: undefined as (() => void) | undefined,
}));

vi.mock('../src/global-kb/connection.js', () => ({
  resolveGlobalKbSettings: async () => ({ ...h.settings }),
  resolveGlobalKbConnection: async (settings: Store, _db: unknown, opts: unknown) => {
    h.connectOpts.push(opts);
    if (h.connectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, h.connectDelayMs));
    return {
      store: settings.connectionString ?? settings.mode,
      pg: Object.assign(() => Promise.resolve([]), {
        end: async (endOpts: unknown) => {
          h.ends.push(endOpts);
          h.onEnd?.();
        },
      }),
      embeddingDimensions: 8,
      close: async () => {
        h.closes += 1;
      },
    };
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
  h.settings = { mode: 'internal', connectionString: null };
  h.connectOpts = [];
  h.connectDelayMs = 0;
  h.ends = [];
  h.closes = 0;
  h.onEnd = undefined;
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

describe('withGlobalKb with limits for one call', () => {
  it('leaves the connection its own limits when none are asked for', async () => {
    h.ensure.mockResolvedValue(undefined);
    const withGlobalKb = await load();
    await withGlobalKb(haiveDb, async () => undefined);
    // The sync job and the api embed and wait on locks inside this call: a bound that was the
    // default would turn their waits into failures.
    expect(h.connectOpts).toEqual([{ connectTimeoutSeconds: undefined }]);
    expect(h.ends).toEqual([]);
  });

  it('hands the connect timeout to the connection, and skips the type fetch once there is a deadline', async () => {
    h.ensure.mockResolvedValue(undefined);
    const withGlobalKb = await load();
    await withGlobalKb(haiveDb, async () => undefined, { connectTimeoutSeconds: 3 });
    await withGlobalKb(haiveDb, async () => undefined, {
      connectTimeoutSeconds: 3,
      deadlineMs: 5000,
    });
    expect(h.connectOpts).toEqual([
      { connectTimeoutSeconds: 3 },
      { connectTimeoutSeconds: 3, fetchTypes: false },
    ]);
  });

  it('returns what fn returns, closes once and never destroys the pool when fn finishes first', async () => {
    h.ensure.mockResolvedValue(undefined);
    const withGlobalKb = await load();
    await expect(withGlobalKb(haiveDb, async () => 'done', { deadlineMs: 5000 })).resolves.toBe(
      'done',
    );
    expect(h.closes).toBe(1);
    expect(h.ends).toEqual([]);
  });

  it('passes fn failures through unchanged inside the deadline', async () => {
    h.ensure.mockResolvedValue(undefined);
    const withGlobalKb = await load();
    await expect(
      withGlobalKb(
        haiveDb,
        async () => {
          throw new Error('query failed');
        },
        { deadlineMs: 5000 },
      ),
    ).rejects.toThrow('query failed');
    expect(h.ends).toEqual([]);
  });

  it('rejects at the deadline and destroys the pool at once, when the store goes silent', async () => {
    h.ensure.mockResolvedValue(undefined);
    const withGlobalKb = await load();
    let release!: (err: Error) => void;
    h.onEnd = () => release(new Error('connection destroyed'));
    const started = performance.now();
    const call = withGlobalKb(
      haiveDb,
      () => new Promise<never>((_, reject) => (release = reject)),
      { deadlineMs: 80 },
    );
    await expect(call).rejects.toMatchObject({
      code: 'GLOBAL_KB_DEADLINE',
      name: 'GlobalKbDeadlineError',
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(h.ends).toEqual([{ timeout: 0 }]);
    // fn settles because the pool was destroyed, and the connection is still closed after it.
    await vi.waitFor(() => expect(h.closes).toBe(1));
  });

  it('rejects at the deadline while the schema is still being ensured', async () => {
    h.ensure.mockImplementation(() => new Promise(() => {}));
    const withGlobalKb = await load();
    await expect(
      withGlobalKb(haiveDb, async () => 'never', { deadlineMs: 60 }),
    ).rejects.toMatchObject({
      code: 'GLOBAL_KB_DEADLINE',
    });
    expect(h.ends).toEqual([{ timeout: 0 }]);
  });

  it('destroys a connection that only opens after the deadline has passed', async () => {
    h.ensure.mockResolvedValue(undefined);
    h.connectDelayMs = 150;
    const withGlobalKb = await load();
    const ran = vi.fn();
    await expect(
      withGlobalKb(haiveDb, async () => ran(), { deadlineMs: 40 }),
    ).rejects.toMatchObject({ code: 'GLOBAL_KB_DEADLINE' });
    expect(h.ends).toEqual([]);
    await vi.waitFor(() => expect(h.ends).toEqual([{ timeout: 0 }]), { timeout: 2000 });
  });
});

describe('the schema ensure of a call with a deadline', () => {
  it('does not fail an unbounded call when its own deadline destroys the pool mid-ensure', async () => {
    let destroyed!: (err: Error) => void;
    let started!: () => void;
    const ensureStarted = new Promise<void>((resolve) => (started = resolve));
    h.ensure
      .mockImplementationOnce(() => {
        started();
        return new Promise<void>((_, reject) => (destroyed = reject));
      })
      .mockResolvedValue(undefined);
    h.onEnd = () => destroyed(new Error('connection destroyed'));
    const withGlobalKb = await load();

    const bounded = withGlobalKb(haiveDb, async () => 'bounded', { deadlineMs: 60 });
    await ensureStarted;
    const unbounded = withGlobalKb(haiveDb, async () => 'unbounded');

    await expect(bounded).rejects.toMatchObject({ code: 'GLOBAL_KB_DEADLINE' });
    await expect(unbounded).resolves.toBe('unbounded');
  });

  it('waits for the ensure another call started and runs none of its own', async () => {
    let finish!: () => void;
    h.ensure.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const withGlobalKb = await load();
    const ran: string[] = [];

    const unbounded = withGlobalKb(haiveDb, async () => void ran.push('unbounded'));
    await vi.waitFor(() => expect(h.ensure).toHaveBeenCalledTimes(1));
    const bounded = withGlobalKb(haiveDb, async () => void ran.push('bounded'), {
      deadlineMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual([]);

    finish();
    await Promise.all([unbounded, bounded]);
    expect(ran.sort()).toEqual(['bounded', 'unbounded']);
    expect(h.ensure).toHaveBeenCalledTimes(1);
  });

  it('records the ensure it ran itself once it succeeded, so later calls run none', async () => {
    h.ensure.mockResolvedValue(undefined);
    const withGlobalKb = await load();
    await withGlobalKb(haiveDb, async () => undefined, { deadlineMs: 5000 });
    await withGlobalKb(haiveDb, async () => undefined);
    await withGlobalKb(haiveDb, async () => undefined, { deadlineMs: 5000 });
    expect(h.ensure).toHaveBeenCalledTimes(1);
  });

  it('records nothing when its own ensure failed, so the next call ensures again', async () => {
    h.ensure.mockRejectedValueOnce(new Error('ensure failed')).mockResolvedValueOnce(undefined);
    const withGlobalKb = await load();
    await expect(
      withGlobalKb(haiveDb, async () => undefined, { deadlineMs: 5000 }),
    ).rejects.toThrow('ensure failed');
    await withGlobalKb(haiveDb, async () => undefined, { deadlineMs: 5000 });
    expect(h.ensure).toHaveBeenCalledTimes(2);
  });
});
