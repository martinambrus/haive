import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const store = new Map<string, string>();
const liveSlots = () => [...store.values()].filter((v) => Number(v) > Date.now()).length;
const fakeRedis = {
  hset: async (_k: string, f: string, v: string) => void store.set(f, v),
  hgetall: async () => Object.fromEntries(store),
  hdel: async (_k: string, ...fields: string[]) => void fields.forEach((f) => store.delete(f)),
  del: async () => void store.clear(),
  // The same decision as ACQUIRE_LEASE_SCRIPT, run without an await so it is atomic like a script.
  eval: async (_script: string, _n: number, _k: string, ...a: (string | number)[]) => {
    const [now, expiry, , cap] = a.map(Number) as [number, number, number, number];
    const field = String(a[2]);
    let live = 0;
    for (const [f, v] of [...store]) {
      if (Number(v) > now) live += 1;
      else store.delete(f);
    }
    if (store.has(field)) {
      store.set(field, String(expiry));
      return [1, live];
    }
    if (live >= cap) return [0, live];
    store.set(field, String(expiry));
    return [1, live];
  },
};
vi.mock('../../redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../redis.js')>()),
  getRedis: () => fakeRedis,
}));

const {
  ACQUIRE_LEASE_SCRIPT,
  AgentLeaseAbortedError,
  AgentLeaseTimeoutError,
  acquireAgentLease,
  clearAgentLeases,
  tryAcquireAgentLease,
} = await import('./agent-lease.js');
const { enforceAgentLaneCap } = await import('./handlers.js');

const db = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
} as unknown as Database;

function job(id: string) {
  return { id, moveToDelayed: vi.fn(async () => undefined) };
}

/** An INVOKE job that the lane gate admitted: it holds `invoke:<id>:tok` until released. */
async function admitInvoke(id: string, cap: number) {
  const slot = await enforceAgentLaneCap(db, job(id) as never, 'tok', cap);
  expect(slot).toBeDefined();
  return slot;
}

function deps(cap: number) {
  return { db, agentCap: async () => cap };
}

beforeEach(() => {
  store.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tryAcquireAgentLease', () => {
  it('grants a lease while the pool has room and counts it', async () => {
    await admitInvoke('1', 2);
    const lease = await tryAcquireAgentLease(deps(2));
    expect(lease).not.toBeNull();
    expect(liveSlots()).toBe(2);
  });

  it('refuses when active invocations plus leases fill the pool', async () => {
    await admitInvoke('1', 2);
    expect(await tryAcquireAgentLease(deps(2))).not.toBeNull();
    expect(await tryAcquireAgentLease(deps(2))).toBeNull();
  });

  it('frees the slot when the lease is released after a throw', async () => {
    const lease = await tryAcquireAgentLease(deps(1));
    expect(lease).not.toBeNull();
    await expect(
      (async () => {
        try {
          throw new Error('docker blew up');
        } finally {
          await lease?.release();
        }
      })(),
    ).rejects.toThrow('docker blew up');
    expect(liveSlots()).toBe(0);
    expect(await tryAcquireAgentLease(deps(1))).not.toBeNull();
  });

  it('release is idempotent', async () => {
    const lease = await tryAcquireAgentLease(deps(1));
    await lease?.release();
    await lease?.release();
    expect(liveSlots()).toBe(0);
  });

  it('stops counting a lease whose heartbeat stopped', async () => {
    vi.useFakeTimers();
    await tryAcquireAgentLease(deps(1));
    expect(liveSlots()).toBe(1);
    store.set([...store.keys()][0] as string, String(Date.now() - 1));
    expect(liveSlots()).toBe(0);
    expect(await tryAcquireAgentLease(deps(1))).not.toBeNull();
    expect(store.size).toBe(1);
  });

  it('keeps a held lease alive with its heartbeat', async () => {
    vi.useFakeTimers();
    const lease = await tryAcquireAgentLease(deps(1));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(liveSlots()).toBe(1);
    await lease?.release();
  });
});

describe('concurrent acquirers', () => {
  it('lets exactly one of five take the last free slot', async () => {
    const got = await Promise.all(Array.from({ length: 5 }, () => tryAcquireAgentLease(deps(1))));
    expect(got.filter((l) => l !== null)).toHaveLength(1);
    expect(liveSlots()).toBe(1);
  });

  it('never grants more leases than the cap leaves', async () => {
    await admitInvoke('1', 3);
    const got = await Promise.all(Array.from({ length: 5 }, () => tryAcquireAgentLease(deps(3))));
    expect(got.filter((l) => l !== null)).toHaveLength(2);
  });
});

describe.skipIf(!process.env.HAIVE_LEASE_TEST_REDIS_URL)(
  'ACQUIRE_LEASE_SCRIPT on a real Redis',
  () => {
    const key = 'haive:agent-lease-test';
    async function withRedis(run: (r: import('ioredis').Redis) => Promise<void>): Promise<void> {
      const { Redis } = await import('ioredis');
      const r = new Redis(process.env.HAIVE_LEASE_TEST_REDIS_URL as string);
      try {
        await r.del(key);
        await run(r);
      } finally {
        await r.del(key);
        r.disconnect();
      }
    }
    const take = (r: import('ioredis').Redis, now: number, field: string, cap: number) =>
      r.eval(ACQUIRE_LEASE_SCRIPT, 1, key, now, now + 60_000, field, cap) as Promise<number[]>;

    it('inserts for exactly one of five simultaneous callers on one free slot', async () => {
      await withRedis(async (r) => {
        const now = Date.now();
        const res = await Promise.all(
          Array.from({ length: 5 }, (_, i) => take(r, now, `lease:l${i}`, 1)),
        );
        expect(res.filter(([reserved]) => reserved === 1)).toHaveLength(1);
        expect(await r.hlen(key)).toBe(1);
      });
    });

    it('lets exactly one of an invoke: and a lease: reservation win the last free slot', async () => {
      await withRedis(async (r) => {
        const now = Date.now();
        await r.hset(
          key,
          'invoke:held:a',
          String(now + 60_000),
          'lease:held',
          String(now + 60_000),
        );
        const res = await Promise.all([
          ...Array.from({ length: 4 }, (_, i) => take(r, now, `invoke:j${i}:tok`, 3)),
          ...Array.from({ length: 4 }, (_, i) => take(r, now, `lease:l${i}`, 3)),
        ]);
        expect(res.filter(([reserved]) => reserved === 1)).toHaveLength(1);
        expect(await r.hlen(key)).toBe(3);
      });
    });

    it('refreshes a field it already holds without counting it again', async () => {
      await withRedis(async (r) => {
        const now = Date.now();
        expect(await take(r, now, 'invoke:j:tok', 1)).toEqual([1, 0]);
        expect(await take(r, now, 'invoke:j:tok', 1)).toEqual([1, 1]);
        expect(await take(r, now, 'lease:other', 1)).toEqual([0, 1]);
        expect(await r.hlen(key)).toBe(1);
      });
    });

    it('drops expired fields and reports the live count', async () => {
      await withRedis(async (r) => {
        const now = Date.now();
        await r.hset(key, 'old', String(now - 1), 'live', String(now + 60_000));
        expect(await take(r, now, 'new', 5)).toEqual([1, 1]);
        expect(await r.hkeys(key)).toEqual(expect.arrayContaining(['live', 'new']));
        expect(await r.hexists(key, 'old')).toBe(0);
      });
    });
  },
);

describe('acquireAgentLease', () => {
  it('waits, reports the wait, and takes the slot once it frees', async () => {
    const first = await tryAcquireAgentLease(deps(1));
    const onWait = vi.fn(() => void first?.release());
    const lease = await acquireAgentLease(deps(1), { onWait, pollMs: 1 });
    expect(onWait).toHaveBeenCalledWith(1, 1);
    expect(lease.id).not.toBe(first?.id);
  });

  it('gives up after waitMs', async () => {
    await tryAcquireAgentLease(deps(1));
    await expect(acquireAgentLease(deps(1), { waitMs: 5, pollMs: 1 })).rejects.toBeInstanceOf(
      AgentLeaseTimeoutError,
    );
  });

  it('stops waiting when aborted', async () => {
    await tryAcquireAgentLease(deps(1));
    const ac = new AbortController();
    const waiting = acquireAgentLease(deps(1), { signal: ac.signal, pollMs: 60_000 });
    setTimeout(() => ac.abort(), 5);
    await expect(waiting).rejects.toBeInstanceOf(AgentLeaseAbortedError);
  });
});

describe('clearAgentLeases', () => {
  it('clears every lease', async () => {
    await tryAcquireAgentLease(deps(5));
    await tryAcquireAgentLease(deps(5));
    expect(liveSlots()).toBe(2);
    await clearAgentLeases();
    expect(liveSlots()).toBe(0);
  });
});

describe('enforceAgentLaneCap with leases', () => {
  it('admits a second INVOKE when only one of two slots is taken by a job', async () => {
    await admitInvoke('1', 2);
    const j = job('2');
    await expect(enforceAgentLaneCap(db, j as never, 'tok', 2)).resolves.toBeDefined();
    expect(j.moveToDelayed).not.toHaveBeenCalled();
  });

  it('defers a second INVOKE when one slot is a job and the other a live lease', async () => {
    await admitInvoke('1', 2);
    await tryAcquireAgentLease(deps(3));
    const j = job('2');
    await expect(enforceAgentLaneCap(db, j as never, 'tok', 2)).rejects.toThrow();
    expect(j.moveToDelayed).toHaveBeenCalledTimes(1);
  });

  it('still admits the first INVOKE while a lease holds the other slot', async () => {
    await tryAcquireAgentLease(deps(3));
    const j = job('1');
    await expect(enforceAgentLaneCap(db, j as never, 'tok', 2)).resolves.toBeDefined();
  });

  it('admits nothing when leases fill the pool', async () => {
    await tryAcquireAgentLease(deps(9));
    await tryAcquireAgentLease(deps(9));
    const j = job('1');
    await expect(enforceAgentLaneCap(db, j as never, 'tok', 2)).rejects.toThrow();
  });

  it('frees the slot when the admitted INVOKE releases it', async () => {
    const slot = await admitInvoke('1', 1);
    await expect(enforceAgentLaneCap(db, job('2') as never, 'tok', 1)).rejects.toThrow();
    await slot?.release();
    await slot?.release();
    expect(await enforceAgentLaneCap(db, job('2') as never, 'tok', 1)).toBeDefined();
  });

  it('lets a job through with no slot when it has no worker token or Redis fails', async () => {
    expect(await enforceAgentLaneCap(db, job('1') as never, undefined, 1)).toBeUndefined();
    const working = fakeRedis.eval;
    fakeRedis.eval = async () => {
      throw new Error('redis down');
    };
    try {
      expect(await enforceAgentLaneCap(db, job('1') as never, 'tok', 1)).toBeUndefined();
    } finally {
      fakeRedis.eval = working;
    }
  });
});
