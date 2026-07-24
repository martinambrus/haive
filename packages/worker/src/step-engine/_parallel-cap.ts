import { resolveAgentConcurrency } from '../sandbox/runtime-admission.js';

/** Concurrency when config is unavailable (e.g. focused unit tests) or the governor is off. */
const STATIC_PARALLEL_CAP = 3;

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
    return Math.max(1, Math.floor(await resolveAgentConcurrency(STATIC_PARALLEL_CAP)));
  } catch {
    return STATIC_PARALLEL_CAP;
  }
}
