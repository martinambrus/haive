import { getRedis } from '../../redis.js';
import { log } from './_shared.js';

/** Redis key holding "this invocation is being killed by the preemption sweeper, not by anything
 *  wrong with the run". Written just before the container is removed; read by the dying run's own
 *  failure interpretation so the row gets CLI_PREEMPTED_HEADLINE instead of the generic
 *  "stopped before it finished" — which is what keeps the eviction out of every retry budget.
 *
 *  Redis rather than an in-process Set because the mark crosses a boundary that a Map cannot: the
 *  sweeper decides, and a DIFFERENT execution context (the cli-exec job that owns the spawn) reads
 *  it. Today both live in one worker process, but nothing in the design says they must. */
const KEY_PREFIX = 'cli-preempt:';

/** Long enough to cover container teardown and the spawn's own unwinding, short enough that a mark
 *  whose run somehow survives cannot mislabel a LATER failure of the same invocation. Preemption
 *  to process exit is sub-second in practice. */
const MARK_TTL_SECONDS = 300;

/** Mark an invocation as being preempted. Best-effort: if this write fails the kill still happens,
 *  the run is simply recorded as a generic transient stop — recoverable, just chargeable to the
 *  orphan budget. Never let a Redis hiccup abort the eviction. */
export async function markPreempted(invocationId: string): Promise<void> {
  try {
    await getRedis().set(`${KEY_PREFIX}${invocationId}`, '1', 'EX', MARK_TTL_SECONDS);
  } catch (err) {
    log.warn({ err, invocationId }, 'preemption mark write failed; kill will read as generic stop');
  }
}

/** Read-and-clear the mark for an invocation. Consumed rather than merely read so a re-dispatched
 *  invocation can never inherit its predecessor's label. Returns false on any error — the failure
 *  mode is "charged to the orphan budget", never "silently unbounded". */
export async function consumePreemptionMark(invocationId: string): Promise<boolean> {
  try {
    const removed = await getRedis().del(`${KEY_PREFIX}${invocationId}`);
    return removed > 0;
  } catch (err) {
    log.warn({ err, invocationId }, 'preemption mark read failed; treating as a generic stop');
    return false;
  }
}
