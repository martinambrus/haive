import { VERSION_REFRESH_JOB_ID } from '@haive/shared';
import { HttpError } from '../context.js';
import { getCliExecQueue } from '../queues.js';

// BullMQ ids: plain adds use its counter; scheduler ticks use repeat:<schedulerId>:<ms>.
const POLLABLE_JOB_ID = new RegExp(
  `^(?:[1-9][0-9]*|repeat:${VERSION_REFRESH_JOB_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[1-9][0-9]*)$`,
);

/** Load a job the UI is polling, or 404.
 *
 *  `name` pins the job kind so one poll route can never read another kind's return value —
 *  the routes differ in what they expose (a probe result, a sign-out summary), and the job id
 *  alone does not say which. `owner` additionally pins the payload to the caller for the
 *  per-provider jobs. Everything that fails a check is reported as missing rather than
 *  forbidden: the id is the only handle, so a distinct "exists but not yours" would confirm
 *  live ids to whoever guesses one. */
export async function loadPollableJob(
  jobId: string,
  name: string,
  owner?: { providerId: string; userId: string },
) {
  if (!POLLABLE_JOB_ID.test(jobId)) {
    throw new HttpError(404, 'job not found — it may have expired', 'job_expired');
  }
  const job = await getCliExecQueue().getJob(jobId);
  const data = job?.data as { providerId?: string; userId?: string } | undefined;
  if (
    !job ||
    job.name !== name ||
    (owner && (data?.providerId !== owner.providerId || data?.userId !== owner.userId))
  ) {
    throw new HttpError(404, 'job not found — it may have expired', 'job_expired');
  }
  return job;
}
