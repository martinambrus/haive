import {
  CLI_EXEC_JOB_NAMES,
  CLI_POLLABLE_JOB_OPTS,
  logger,
  type RefreshCliVersionsJobPayload,
} from '@haive/shared';
import { getCliExecQueue } from '../queues.js';

const log = logger.child({ module: 'cli-version-refresh' });

export async function enqueueCliVersionRefresh() {
  const queue = getCliExecQueue();
  // Match the worker's boot check: a delayed scheduler tick is future work. This scan/add
  // is best effort; simultaneous requests can both see an empty queue and enqueue a refresh.
  try {
    // Read at most 100 jobs per state (300 total), comfortably beyond normal active slots,
    // to bound loading INVOKE prompts on each click. Missing an older refresh only duplicates it.
    const inFlight = await queue.getJobs(['active', 'wait', 'prioritized'], 0, 99);
    const job = inFlight.find(
      (candidate) => candidate?.name === CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
    );
    if (job) return job;
  } catch (err) {
    // Like the worker's boot check, fail open: a duplicate is cheaper than no refresh.
    log.warn({ err }, 'version-refresh in-flight check failed; enqueueing anyway');
  }
  return queue.add(
    CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
    {} satisfies RefreshCliVersionsJobPayload,
    CLI_POLLABLE_JOB_OPTS,
  );
}
