import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import type { Database } from '@haive/database';
import { CLI_EXEC_JOB_NAMES } from '@haive/shared';

const hashes = new Map<string, Map<string, string>>();
function hash(key: string): Map<string, string> {
  let h = hashes.get(key);
  if (!h) {
    h = new Map();
    hashes.set(key, h);
  }
  return h;
}

type EvalFn = (script: string, keys: string[], argv: string[]) => unknown;
let acquireLeaseScript = '';

// PLUG-IN POINT: add a branch here for any new script the fix introduces (runs without an await, so it is atomic).
const evalScript: EvalFn = (script, keys, argv) => {
  if (script === acquireLeaseScript) {
    const h = hash(keys[0] as string);
    const [now, expiry, , cap] = argv.map(Number) as [number, number, number, number];
    const field = argv[2] as string;
    let live = 0;
    for (const [f, v] of [...h]) {
      if (Number(v) > now) live += 1;
      else h.delete(f);
    }
    if (h.has(field)) {
      h.set(field, String(expiry));
      return [1, live];
    }
    if (live >= cap) return [0, live];
    h.set(field, String(expiry));
    return [1, live];
  }
  throw new Error(`fake redis: no evaluator for script: ${script.slice(0, 80)}`);
};

const fakeRedis = {
  hset: async (k: string, ...fv: (string | number)[]) => {
    const h = hash(k);
    for (let i = 0; i < fv.length; i += 2) h.set(String(fv[i]), String(fv[i + 1]));
    return fv.length / 2;
  },
  hget: async (k: string, f: string) => hash(k).get(f) ?? null,
  hgetall: async (k: string) => Object.fromEntries(hash(k)),
  hdel: async (k: string, ...fields: string[]) => {
    let n = 0;
    for (const f of fields) if (hash(k).delete(f)) n += 1;
    return n;
  },
  hlen: async (k: string) => hash(k).size,
  hexists: async (k: string, f: string) => (hash(k).has(f) ? 1 : 0),
  del: async (...keys: string[]) => {
    for (const k of keys) hashes.delete(k);
    return keys.length;
  },
  eval: async (script: string, n: number, ...rest: (string | number)[]) => {
    const keys = rest.slice(0, n).map(String);
    const argv = rest.slice(n).map(String);
    return evalScript(script, keys, argv);
  },
};

let activeJobs: unknown[] = [];
let heldRead: Promise<unknown[]> | null = null;

vi.mock('../../redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../redis.js')>()),
  getRedis: () => fakeRedis,
}));
vi.mock('./_shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_shared.js')>()),
  getCliExecQueue: () => ({
    getActive: () => {
      if (heldRead) {
        const held = heldRead;
        heldRead = null;
        return held;
      }
      return Promise.resolve(activeJobs);
    },
  }),
}));

const { ACQUIRE_LEASE_SCRIPT, tryAcquireAgentLease } = await import('./agent-lease.js');
const { enforceAgentLaneCap } = await import('./handlers.js');
acquireLeaseScript = ACQUIRE_LEASE_SCRIPT;

const db = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
} as unknown as Database;

function invoke(id: string, priority = 0) {
  return {
    name: CLI_EXEC_JOB_NAMES.INVOKE,
    id,
    priority,
    data: { invocationId: `inv-${id}` },
  };
}

function job(id: string) {
  return { id, moveToDelayed: vi.fn(async () => undefined) };
}

function deps(cap: number) {
  return { db, agentCap: async () => cap };
}

async function admits(id: string, cap: number): Promise<boolean> {
  try {
    await enforceAgentLaneCap(db, job(id) as never, 'tok', cap);
    return true;
  } catch (err) {
    if (err instanceof DelayedError) return false;
    throw err;
  }
}

const releasers: (() => Promise<void>)[] = [];
async function lease(cap: number) {
  const got = await tryAcquireAgentLease(deps(cap));
  if (got) releasers.push(() => got.release());
  return got;
}

beforeEach(() => {
  hashes.clear();
  activeJobs = [];
  heldRead = null;
});

afterEach(async () => {
  await Promise.all(releasers.splice(0).map((r) => r()));
});

describe('agent pool admission across both lanes', () => {
  describe('cross-lane race: an INVOKE admitted while a lease attempt is mid-read', () => {
    // At cap 2 the fix must keep occupancy <= 2; at cap 3 the overshoot fits, so it measures the ruler.
    it.each([2, 3])('keeps total occupancy within the cap at cap %i', async (cap) => {
      const a = invoke('1');
      const j = invoke('2');

      activeJobs = [a];
      expect(await admits('1', cap)).toBe(true);

      let release!: (jobs: unknown[]) => void;
      heldRead = new Promise<unknown[]>((resolve) => {
        release = resolve;
      });
      const pendingLease = lease(cap);
      heldRead = null;

      activeJobs = [a, j];
      const jAdmitted = await admits('2', cap);

      release([a]);
      const granted = await pendingLease;

      const occupancy = 1 + (jAdmitted ? 1 : 0) + (granted ? 1 : 0);
      expect(occupancy).toBeLessThanOrEqual(cap);
    });
  });

  describe('priority inversion: a later, higher-priority INVOKE', () => {
    it.each([2, 3])('keeps admitted INVOKEs within the cap at cap %i', async (cap) => {
      const a = invoke('1', 5);
      const b = invoke('2', 5);
      const j = invoke('3', 1);

      activeJobs = [a];
      expect(await admits('1', cap)).toBe(true);
      activeJobs = [a, b];
      expect(await admits('2', cap)).toBe(true);
      activeJobs = [a, b, j];
      const jAdmitted = await admits('3', cap);

      expect(2 + (jAdmitted ? 1 : 0)).toBeLessThanOrEqual(cap);
    });
  });

  describe('sanity: the fixture does not reject everything', () => {
    it('admits the first two INVOKEs at cap 2 and refuses a third', async () => {
      const [a, b, c] = [invoke('1'), invoke('2'), invoke('3')];
      activeJobs = [a];
      expect(await admits('1', 2)).toBe(true);
      activeJobs = [a, b];
      expect(await admits('2', 2)).toBe(true);
      activeJobs = [a, b, c];
      expect(await admits('3', 2)).toBe(false);
    });

    it('grants a lease with one INVOKE active at cap 2', async () => {
      activeJobs = [invoke('1')];
      expect(await admits('1', 2)).toBe(true);
      expect(await lease(2)).not.toBeNull();
    });

    it('refuses a lease with two INVOKEs active at cap 2', async () => {
      const [a, b] = [invoke('1'), invoke('2')];
      activeJobs = [a];
      expect(await admits('1', 2)).toBe(true);
      activeJobs = [a, b];
      expect(await admits('2', 2)).toBe(true);
      expect(await lease(2)).toBeNull();
    });
  });
});
