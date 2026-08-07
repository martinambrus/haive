import { api, type CliPackageVersionsEntry, type CliProbeResult } from './api-client';

/** What a running cli-exec job the UI started is doing right now, for the button label.
 *
 *  `queued` is the state this whole polling path exists for: these jobs share `cli-exec-queue`
 *  with agent invocations and cannot preempt one, so waiting minutes behind multi-minute CLI
 *  runs is normal operation, not a failure. Showing it as its own phase is the difference
 *  between "the machine is busy" and the 504 this replaced, which read as "provider broken". */
export type QueuedJobPhase = 'queued' | 'running';

/** Map a BullMQ job state to the two phases the UI distinguishes.
 *
 *  Only `active` means a worker holds the job. `waiting`, `prioritized` and `delayed` are all
 *  just different ways of waiting for a slot, so they collapse into one user-facing phase. */
export function jobPhaseForState(state: string | undefined): QueuedJobPhase {
  return state === 'active' ? 'running' : 'queued';
}

export interface SignOutResult {
  ok: boolean;
  removed: string[];
  failed: { name: string; stderr: string }[];
}

const POLL_INTERVAL_MS = 2_000;

/** How long the browser keeps polling before handing the wait back to the user. Must stay
 *  under the server's POLLABLE_JOB_RETENTION_S (packages/api/src/routes/cli-providers.ts) so a
 *  finished result is never reaped out from under a poll that is still running. */
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const STILL_QUEUED_MESSAGE =
  'Still queued behind running CLI jobs. The job keeps going in the background — reopen this ' +
  'page later to see the result.';

type PollResponse<TDone> =
  | { status: 'pending'; state?: string }
  | ({ status: 'done' } & TDone)
  | { status: 'failed'; error: string };

/** Start a cli-exec job and poll its status route until it finishes.
 *
 *  Resolves with the done response, or throws with a message fit to show the user: the job's
 *  own failure reason, an expired job, or the still-queued notice once the poll window is
 *  spent. Giving up polling does NOT cancel the job — it runs to completion either way. */
async function runQueuedJob<TDone>(
  startPath: string,
  statusPath: (jobId: string) => string,
  onPhase?: (phase: QueuedJobPhase) => void,
): Promise<TDone> {
  const { jobId } = await api.post<{ jobId: string }>(startPath);
  onPhase?.('queued');

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const res = await api.get<PollResponse<TDone>>(statusPath(jobId));
    if (res.status === 'done') return res;
    if (res.status === 'failed') throw new Error(res.error);

    onPhase?.(jobPhaseForState(res.state));
    if (Date.now() >= deadline) throw new Error(STILL_QUEUED_MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function runCliProbe(
  providerId: string,
  onPhase?: (phase: QueuedJobPhase) => void,
): Promise<CliProbeResult> {
  const { result } = await runQueuedJob<{ result: CliProbeResult }>(
    `/cli-providers/${providerId}/test`,
    (jobId) => `/cli-providers/${providerId}/test/${jobId}`,
    onPhase,
  );
  return result;
}

export async function runCliSignOut(
  providerId: string,
  onPhase?: (phase: QueuedJobPhase) => void,
): Promise<SignOutResult> {
  const { result } = await runQueuedJob<{ result: SignOutResult }>(
    `/cli-providers/${providerId}/sign-out`,
    (jobId) => `/cli-providers/${providerId}/sign-out/${jobId}`,
    onPhase,
  );
  return result;
}

export async function runCatalogVersionRefresh(
  name: string,
  onPhase?: (phase: QueuedJobPhase) => void,
): Promise<CliPackageVersionsEntry> {
  const { entry } = await runQueuedJob<{ entry: CliPackageVersionsEntry }>(
    `/cli-providers/catalog/${name}/refresh-versions`,
    (jobId) => `/cli-providers/catalog/${name}/refresh-versions/${jobId}`,
    onPhase,
  );
  return entry;
}
