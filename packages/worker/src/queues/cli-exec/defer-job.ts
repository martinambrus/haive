import type { Job } from 'bullmq';
import { log } from './_shared.js';

/** How long a refused defer is retried before the caller lets the job through. Under the agent
 *  slot lease (`LEASE_TTL_MS`, 2 minutes in agent-lease.ts) on purpose: a job held here still owns
 *  its pool slot, and the slot must not lapse under it. */
export const DEFER_RETRY_WINDOW_MS = 60_000;

/** Pause between attempts. A refusal is one cheap round trip, so the step only has to be short
 *  enough that the job is deferred soon after the store answers. */
const DEFER_RETRY_STEP_MS = 1_000;

/**
 * Move a job this worker holds back to `delayed`, retrying a refusal for DEFER_RETRY_WINDOW_MS.
 *
 * The cli-exec gates (agent lane cap, pause, per-task cap, runtime-holder reserve) hold a job by
 * deferring it, and the defer is a write to the same Redis whose trouble can be the reason the
 * gate is holding. A server that answers LOADING after a restart, or OOM at its memory limit,
 * refuses that write at once, and the caller used to answer a refusal by letting the job run. A
 * transport outage never gets here: the BullMQ connection queues the call and resolves it when
 * the store is back.
 *
 * Throws the last refusal once the window is spent, and the caller decides what that means (the
 * gates let the job run, as they did before). A refusal that is not an outage, such as a lost
 * lock, costs the window and then ends the same way.
 */
export async function deferJob(
  job: Pick<Job, 'id' | 'moveToDelayed'>,
  delayMs: number,
  token: string,
): Promise<void> {
  const giveUpAt = Date.now() + DEFER_RETRY_WINDOW_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await job.moveToDelayed(Date.now() + delayMs, token);
      return;
    } catch (err) {
      if (Date.now() >= giveUpAt) throw err;
      if (attempt === 1) log.warn({ err, jobId: job.id }, 'job defer refused; retrying');
      await new Promise((resolve) => setTimeout(resolve, DEFER_RETRY_STEP_MS));
    }
  }
}
