import { randomUUID } from 'node:crypto';
import type { Database } from '@haive/database';
import { getRedis } from '../../redis.js';
import { log } from './_shared.js';

/**
 * The agent pool: one Redis hash of slot fields, each carrying its own expiry. An INVOKE job
 * holds `invoke:<jobId>:<token>` (`enforceAgentLaneCap`), a run that is not a cli-exec job (a
 * step's own test or lint command in the task sandbox) holds `lease:<uuid>`, and both reserve
 * through one script, so the cap holds exactly across the two lanes.
 *
 * Soft state, like the runtime reservations: the holder refreshes its field while it runs, and
 * worker boot wipes the hash.
 */
const LEASE_KEY = 'haive:agent-lease';
/** Backstop for a holder whose worker died: it stops counting this long after its last beat. */
const LEASE_TTL_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
const POLL_MS = 5_000;

/** KEYS[1] the pool hash; ARGV: now, the field's new expiry, the field, the cap.
 *  Prunes expired fields, refreshes the field if it is held, else inserts it only while live
 *  fields are below the cap. Returns {reserved, live}. */
export const ACQUIRE_LEASE_SCRIPT = `
local fields = redis.call('HGETALL', KEYS[1])
local now = tonumber(ARGV[1])
local live = 0
local held = false
for i = 1, #fields, 2 do
  if (tonumber(fields[i + 1]) or 0) > now then
    live = live + 1
    if fields[i] == ARGV[3] then
      held = true
    end
  else
    redis.call('HDEL', KEYS[1], fields[i])
  end
end
if held then
  redis.call('HSET', KEYS[1], ARGV[3], ARGV[2])
  return {1, live}
end
if live >= tonumber(ARGV[4]) then
  return {0, live}
end
redis.call('HSET', KEYS[1], ARGV[3], ARGV[2])
return {1, live}
`;
/** How long a caller waits for a slot before giving up. */
export const AGENT_LEASE_WAIT_MS = 10 * 60_000;

export class AgentLeaseAbortedError extends Error {
  constructor() {
    super('agent lease wait aborted');
    this.name = 'AgentLeaseAbortedError';
  }
}

export class AgentLeaseTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`no agent slot became free within ${Math.round(waitedMs / 1000)}s`);
    this.name = 'AgentLeaseTimeoutError';
  }
}

export interface AgentLeaseDeps {
  db: Database;
  /** The current size of the agent pool. */
  agentCap: () => Promise<number>;
}

export interface AgentLease {
  id: string;
  /** Idempotent; the heartbeat stops and the slot is free again. */
  release(): Promise<void>;
}

export interface AcquireAgentLeaseOptions {
  onWait?: (busy: number, cap: number) => void;
  signal?: AbortSignal;
  waitMs?: number;
  pollMs?: number;
}

/** Slots held right now, expired fields pruned. A Redis failure reads as none. */
export async function liveAgentLeaseCount(): Promise<number> {
  try {
    const redis = getRedis();
    const all = await redis.hgetall(LEASE_KEY);
    const now = Date.now();
    const expired = Object.keys(all).filter((id) => !(Number(all[id]) > now));
    if (expired.length > 0) await redis.hdel(LEASE_KEY, ...expired);
    return Object.keys(all).length - expired.length;
  } catch (err) {
    log.warn({ err }, 'agent lease read failed; counting none');
    return 0;
  }
}

export interface AgentSlot {
  /** Idempotent; the heartbeat stops and the slot is free again. */
  release(): Promise<void>;
}

async function reserve(
  field: string,
  cap: number,
): Promise<{ slot: AgentSlot } | { live: number }> {
  const redis = getRedis();
  const now = Date.now();
  const [reserved, live] = (await redis.eval(
    ACQUIRE_LEASE_SCRIPT,
    1,
    LEASE_KEY,
    now,
    now + LEASE_TTL_MS,
    field,
    cap,
  )) as [number, number];
  if (reserved !== 1) return { live };
  const beat = setInterval(() => {
    void redis.hset(LEASE_KEY, field, String(Date.now() + LEASE_TTL_MS)).catch((err: unknown) => {
      log.warn({ err, field }, 'agent slot heartbeat failed');
    });
  }, HEARTBEAT_MS);
  beat.unref();
  let released = false;
  return {
    slot: {
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        await redis.hdel(LEASE_KEY, field).catch((err: unknown) => {
          log.warn({ err, field }, 'agent slot release failed; its expiry will clear it');
        });
      },
    },
  };
}

/** The slot `field` if the pool of `cap` has room (or already holds `field`), else null.
 *  Throws when Redis is unreachable. */
export async function reserveAgentSlot(field: string, cap: number): Promise<AgentSlot | null> {
  const got = await reserve(field, cap);
  return 'slot' in got ? got.slot : null;
}

async function attempt(
  deps: AgentLeaseDeps,
): Promise<{ lease: AgentLease } | { busy: number; cap: number }> {
  const cap = await deps.agentCap();
  const id = randomUUID();
  const got = await reserve(`lease:${id}`, cap);
  if ('slot' in got) return { lease: { id, release: () => got.slot.release() } };
  return { busy: got.live, cap };
}

/** A lease if a slot is free right now, else null. */
export async function tryAcquireAgentLease(deps: AgentLeaseDeps): Promise<AgentLease | null> {
  const got = await attempt(deps);
  return 'lease' in got ? got.lease : null;
}

/** Waits for a slot, polling. Throws AgentLeaseAbortedError when `signal` fires and
 *  AgentLeaseTimeoutError after `waitMs`. The caller MUST release the lease in a finally. */
export async function acquireAgentLease(
  deps: AgentLeaseDeps,
  options: AcquireAgentLeaseOptions = {},
): Promise<AgentLease> {
  const { onWait, signal } = options;
  const waitMs = options.waitMs ?? AGENT_LEASE_WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted) throw new AgentLeaseAbortedError();
    const got = await attempt(deps);
    if ('lease' in got) return got.lease;
    if (Date.now() - startedAt >= waitMs) throw new AgentLeaseTimeoutError(waitMs);
    onWait?.(got.busy, got.cap);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollMs);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

/** Wipe every lease. Called on worker boot, where every sandbox the previous process started is
 *  reaped, so a lease left behind describes a run that no longer exists. */
export async function clearAgentLeases(): Promise<void> {
  try {
    await getRedis().del(LEASE_KEY);
  } catch (err) {
    log.warn({ err }, 'clearing agent leases on boot failed');
  }
}
