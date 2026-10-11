import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { CLI_EXEC_JOB_NAMES } from '@haive/shared';

const store = new Map<string, string>();
const fakeRedis = {
  hset: async (_k: string, f: string, v: string) => void store.set(f, v),
  hgetall: async () => Object.fromEntries(store),
  hdel: async (_k: string, ...fields: string[]) => void fields.forEach((f) => store.delete(f)),
  del: async () => void store.clear(),
};
let activeJobs: unknown[] = [];

vi.mock('../../redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../redis.js')>()),
  getRedis: () => fakeRedis,
}));
vi.mock('./_shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_shared.js')>()),
  getCliExecQueue: () => ({ getActive: async () => activeJobs }),
}));

const {
  AgentLeaseAbortedError,
  AgentLeaseTimeoutError,
  acquireAgentLease,
  clearAgentLeases,
  liveAgentLeaseCount,
  tryAcquireAgentLease,
} = await import('./agent-lease.js');
const { enforceAgentLaneCap } = await import('./handlers.js');

const db = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
} as unknown as Database;

function invoke(id: string) {
  return { name: CLI_EXEC_JOB_NAMES.INVOKE, id, priority: 0, data: { invocationId: `inv-${id}` } };
}

function deps(cap: number) {
  return { db, agentCap: async () => cap };
}

beforeEach(() => {
  store.clear();
  activeJobs = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tryAcquireAgentLease', () => {
  it('grants a lease while the pool has room and counts it', async () => {
    activeJobs = [invoke('1')];
    const lease = await tryAcquireAgentLease(deps(2));
    expect(lease).not.toBeNull();
    expect(await liveAgentLeaseCount()).toBe(1);
  });

  it('refuses when active invocations plus leases fill the pool', async () => {
    activeJobs = [invoke('1')];
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
    expect(await liveAgentLeaseCount()).toBe(0);
    expect(await tryAcquireAgentLease(deps(1))).not.toBeNull();
  });

  it('release is idempotent', async () => {
    const lease = await tryAcquireAgentLease(deps(1));
    await lease?.release();
    await lease?.release();
    expect(await liveAgentLeaseCount()).toBe(0);
  });

  it('stops counting a lease whose heartbeat stopped', async () => {
    vi.useFakeTimers();
    await tryAcquireAgentLease(deps(1));
    expect(await liveAgentLeaseCount()).toBe(1);
    store.set([...store.keys()][0] as string, String(Date.now() - 1));
    expect(await liveAgentLeaseCount()).toBe(0);
    expect(store.size).toBe(0);
  });

  it('keeps a held lease alive with its heartbeat', async () => {
    vi.useFakeTimers();
    const lease = await tryAcquireAgentLease(deps(1));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await liveAgentLeaseCount()).toBe(1);
    await lease?.release();
  });

  it('does not count a finished invocation still sitting in the active set', async () => {
    activeJobs = [invoke('1')];
    const finishedDb = {
      select: () => ({ from: () => ({ where: async () => [{ id: 'inv-1' }] }) }),
    } as unknown as Database;
    expect(await tryAcquireAgentLease({ db: finishedDb, agentCap: async () => 1 })).not.toBeNull();
  });
});

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
    expect(await liveAgentLeaseCount()).toBe(2);
    await clearAgentLeases();
    expect(await liveAgentLeaseCount()).toBe(0);
  });
});

describe('enforceAgentLaneCap with leases', () => {
  function job(id: string) {
    return { id, moveToDelayed: vi.fn(async () => undefined) };
  }

  it('admits a second INVOKE when only one of two slots is taken by a job', async () => {
    activeJobs = [invoke('1'), invoke('2')];
    const j = job('2');
    await expect(enforceAgentLaneCap(db, j as never, 'tok', 2)).resolves.toBeUndefined();
    expect(j.moveToDelayed).not.toHaveBeenCalled();
  });

  it('defers a second INVOKE when one slot is a job and the other a live lease', async () => {
    activeJobs = [invoke('1'), invoke('2')];
    await tryAcquireAgentLease(deps(3));
    const j = job('2');
    await expect(enforceAgentLaneCap(db, j as never, 'tok', 2)).rejects.toThrow();
    expect(j.moveToDelayed).toHaveBeenCalledTimes(1);
  });

  it('still admits the first INVOKE while a lease holds the other slot', async () => {
    activeJobs = [invoke('1')];
    await tryAcquireAgentLease(deps(3));
    const j = job('1');
    await expect(enforceAgentLaneCap(db, j as never, 'tok', 2)).resolves.toBeUndefined();
  });

  it('admits nothing when leases fill the pool', async () => {
    activeJobs = [invoke('1')];
    await tryAcquireAgentLease(deps(9));
    await tryAcquireAgentLease(deps(9));
    const j = job('1');
    await expect(enforceAgentLaneCap(db, j as never, 'tok', 2)).rejects.toThrow();
  });
});
