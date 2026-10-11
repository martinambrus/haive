import { randomUUID } from 'node:crypto';
import { and, inArray, isNotNull, or } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CLI_EXEC_JOB_NAMES, type CliExecJobPayload } from '@haive/shared';
import { getRedis } from '../../redis.js';
import { getCliExecQueue, log } from './_shared.js';

/**
 * An agent lease: a run that is not a cli-exec job (a step's own test or lint command in the
 * task sandbox) holds one slot of the agent pool for its length.
 *
 * A slot IS a position among the active INVOKE jobs (`enforceAgentLaneCap`), so a lease cannot
 * take a place in that set. It is a Redis hash the gate reads instead: the gate admits an INVOKE
 * when its rank is below `agentCap - liveLeases`, and a lease is granted while unfinished active
 * INVOKE jobs plus live leases are below `agentCap`.
 *
 * Soft state, like the runtime reservations: a field carries its own expiry, the holder refreshes
 * it while it runs, and worker boot wipes the hash.
 */
const LEASE_KEY = 'haive:agent-lease';
/** Backstop for a holder whose worker died: it stops counting this long after its last beat. */
const LEASE_TTL_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
const POLL_MS = 5_000;

/** KEYS[1] the lease hash; ARGV: now, the new field's expiry, its id, active INVOKE jobs, the cap.
 *  Prunes expired fields, then inserts only while live + INVOKE jobs stay below the cap. Returns
 *  {inserted, live}. */
export const ACQUIRE_LEASE_SCRIPT = `
local fields = redis.call('HGETALL', KEYS[1])
local now = tonumber(ARGV[1])
local live = 0
for i = 1, #fields, 2 do
  if (tonumber(fields[i + 1]) or 0) > now then
    live = live + 1
  else
    redis.call('HDEL', KEYS[1], fields[i])
  end
end
if live + tonumber(ARGV[4]) >= tonumber(ARGV[5]) then
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

/** Of `ids`, those whose invocation is already finalized — ended, or superseded by a retry or
 *  a cancel. Fails OPEN (empty set): an unreadable answer ranks exactly as it did before this
 *  exclusion existed, which over-holds a slot rather than over-admitting agents. */
export async function finalizedInvocationIds(db: Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try {
    const rows = await db
      .select({ id: schema.cliInvocations.id })
      .from(schema.cliInvocations)
      .where(
        and(
          inArray(schema.cliInvocations.id, ids),
          or(
            isNotNull(schema.cliInvocations.endedAt),
            isNotNull(schema.cliInvocations.supersededAt),
          ),
        ),
      );
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    log.warn({ err }, 'agent-lane finalized lookup failed; ranking without the exclusion');
    return new Set();
  }
}

/** Leases held right now, expired fields pruned. A Redis failure reads as none: the gate then
 *  behaves as it did before leases existed, never blocks. */
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

/** Active INVOKE jobs that still have work to do, i.e. the slots cli-exec itself occupies. */
async function unfinishedActiveAgents(db: Database): Promise<number> {
  try {
    const active = await getCliExecQueue().getActive(0, -1);
    const invocationIds = active
      .filter((j) => j?.name === CLI_EXEC_JOB_NAMES.INVOKE && j.id)
      .map((j) => (j.data as CliExecJobPayload).invocationId);
    const finalized = await finalizedInvocationIds(db, invocationIds);
    return invocationIds.filter((id) => !finalized.has(id)).length;
  } catch (err) {
    log.warn({ err }, 'active agent count failed; counting none');
    return 0;
  }
}

async function attempt(
  deps: AgentLeaseDeps,
): Promise<{ lease: AgentLease } | { busy: number; cap: number }> {
  const [used, cap] = await Promise.all([unfinishedActiveAgents(deps.db), deps.agentCap()]);
  const id = randomUUID();
  const redis = getRedis();
  const now = Date.now();
  // The INVOKE count is read outside Redis, so an INVOKE admitted meanwhile can overshoot by one.
  const [inserted, live] = (await redis.eval(
    ACQUIRE_LEASE_SCRIPT,
    1,
    LEASE_KEY,
    now,
    now + LEASE_TTL_MS,
    id,
    used,
    cap,
  )) as [number, number];
  if (inserted !== 1) return { busy: used + live, cap };
  const beat = setInterval(() => {
    void redis.hset(LEASE_KEY, id, String(Date.now() + LEASE_TTL_MS)).catch((err: unknown) => {
      log.warn({ err, leaseId: id }, 'agent lease heartbeat failed');
    });
  }, HEARTBEAT_MS);
  beat.unref();
  let released = false;
  return {
    lease: {
      id,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        await redis.hdel(LEASE_KEY, id).catch((err: unknown) => {
          log.warn({ err, leaseId: id }, 'agent lease release failed; its expiry will clear it');
        });
      },
    },
  };
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
