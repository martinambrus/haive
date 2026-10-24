import {
  CLI_EXEC_JOB_NAMES,
  CLI_POLLABLE_JOB_OPTS,
  type RefreshCliVersionsJobPayload,
} from '@haive/shared';
import { getCliExecQueue } from '../queues.js';

export async function enqueueCliVersionRefresh() {
  const queue = getCliExecQueue();
  // Match the worker's boot check: a delayed scheduler tick is future work. This scan/add
  // is best effort; simultaneous requests can both see an empty queue and enqueue a refresh.
  const inFlight = await queue.getJobs(['active', 'wait', 'prioritized']);
  return (
    inFlight.find((candidate) => candidate?.name === CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS) ??
    (await queue.add(
      CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
      {} satisfies RefreshCliVersionsJobPayload,
      CLI_POLLABLE_JOB_OPTS,
    ))
  );
}
