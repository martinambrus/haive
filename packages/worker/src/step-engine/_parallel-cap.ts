import { STATIC_PARALLEL_AGENTS, currentAgentCap } from '../queues/cli-exec/agent-pool-cap.js';

/**
 * The max parallel agents/CLI invocations (floored at 1; no upper limit — set per
 * host capacity). Resolved through the same path as the cli-exec queue's own
 * concurrency, so a pinned MAX_PARALLEL_AGENTS binds both and an auto-sized one
 * shrinks in-process fan-outs while the runtime pool is full — otherwise the fan-out
 * limiter would happily start 3 agents the queue has no budget for. Pairs with
 * `mapWithConcurrency` from @haive/shared.
 */
export async function resolveParallelCap(): Promise<number> {
  try {
    return await currentAgentCap();
  } catch {
    return STATIC_PARALLEL_AGENTS;
  }
}
