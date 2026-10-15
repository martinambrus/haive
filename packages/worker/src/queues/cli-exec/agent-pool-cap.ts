import { resolveAgentConcurrency } from '../../sandbox/runtime-admission.js';

/** Concurrency used when config is unavailable, or when the resource governor is off and there
 *  is no budget to size against. The pre-feature fixed value. */
export const STATIC_PARALLEL_AGENTS = 3;

/** Floor the parallel-agent cap at 1 (BullMQ requires concurrency >= 1). No upper
 *  limit — the host operator sets it to whatever their machine can handle. */
function clampParallelCap(n: number): number {
  if (!Number.isFinite(n)) return STATIC_PARALLEL_AGENTS;
  return Math.max(1, Math.floor(n));
}

/** The agent pool's size right now: what the INVOKE gate admits against and a lease is sized by. */
export async function currentAgentCap(): Promise<number> {
  return clampParallelCap(await resolveAgentConcurrency(STATIC_PARALLEL_AGENTS));
}

let publishedAgentCap: number | undefined;

export function publishAgentCap(cap: number): void {
  publishedAgentCap = cap;
}

/** The cap the INVOKE gate admits against, for the lease lane: the worker's last read, else a fresh one. */
export async function agentPoolCap(): Promise<number> {
  return publishedAgentCap ?? currentAgentCap();
}
