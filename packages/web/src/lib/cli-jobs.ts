import type { RefreshCliVersionsJobResult } from '@haive/shared/constants';
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
 *  under CLI_POLLABLE_JOB_OPTS' retention (packages/shared/src/constants/index.ts) so a
 *  finished result is never reaped out from under a poll that is still running. */
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function pollTimeout(phase: QueuedJobPhase): Error {
  const state = phase === 'running' ? 'running' : 'queued behind running CLI jobs';
  return new Error(
    `Still ${state}. The job keeps going in the background — reopen this page later to see the result.`,
  );
}

const MAX_CONSECUTIVE_POLL_FAILURES = 3;

function pollDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

type PollResponse<TDone> =
  | { status: 'pending'; state?: string }
  | ({ status: 'done' } & TDone)
  | { status: 'failed'; error: string };

/** Start a cli-exec job and poll its status route until it finishes.
 *
 *  Resolves with the done response, or throws with a message fit to show the user: the job's
 *  own failure reason, an expired job, or the last observed phase once the poll window is
 *  spent. Giving up polling does NOT cancel the job — it runs to completion either way. */
async function runQueuedJob<TDone>(
  startPath: string,
  statusPath: (jobId: string) => string,
  onPhase?: (phase: QueuedJobPhase) => void,
  signal?: AbortSignal,
): Promise<TDone> {
  signal?.throwIfAborted();
  const { jobId } = signal
    ? await api.post<{ jobId: string }>(startPath, undefined, signal)
    : await api.post<{ jobId: string }>(startPath);
  signal?.throwIfAborted();
  let phase: QueuedJobPhase = 'queued';
  onPhase?.(phase);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let failures = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw pollTimeout(phase);
    let res: PollResponse<TDone>;
    try {
      res = signal
        ? await api.get<PollResponse<TDone>>(statusPath(jobId), signal)
        : await api.get<PollResponse<TDone>>(statusPath(jobId));
    } catch (error) {
      signal?.throwIfAborted();
      const { status, code } = error as { status?: number; code?: string };
      // Expiry and other client refusals are final; retry only transient requests.
      if (
        code === 'job_expired' ||
        (status !== undefined && status < 500 && status !== 408 && status !== 429) ||
        ++failures >= MAX_CONSECUTIVE_POLL_FAILURES
      )
        throw error;
      if (Date.now() >= deadline) throw pollTimeout(phase);
      await pollDelay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), signal);
      continue;
    }
    signal?.throwIfAborted();
    failures = 0;
    if (res.status === 'done') return res;
    if (res.status === 'failed') throw new Error(res.error);

    phase = jobPhaseForState(res.state);
    onPhase?.(phase);
    if (Date.now() >= deadline) throw pollTimeout(phase);
    await pollDelay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), signal);
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

/** Neither refresh runner throws when `result.ok` is false: the sources that did refresh were
 *  applied, and a throw would make the caller skip using them. The caller shows `result`. The
 *  catalog poll answers it to an admin only, so for anyone else it is undefined. */
export async function runCatalogVersionRefresh(
  name: string,
  onPhase?: (phase: QueuedJobPhase) => void,
): Promise<{ entry: CliPackageVersionsEntry; result: RefreshCliVersionsJobResult | undefined }> {
  const { entry, result } = await runQueuedJob<{
    entry: CliPackageVersionsEntry;
    result?: RefreshCliVersionsJobResult;
  }>(
    `/cli-providers/catalog/${name}/refresh-versions`,
    (jobId) => `/cli-providers/catalog/${name}/refresh-versions/${jobId}`,
    onPhase,
  );
  return { entry, result };
}

export async function runPricingRefresh(
  onPhase?: (phase: QueuedJobPhase) => void,
  signal?: AbortSignal,
): Promise<RefreshCliVersionsJobResult> {
  const { result } = await runQueuedJob<{ result: RefreshCliVersionsJobResult }>(
    '/cli-pricing/refresh',
    (jobId) => `/cli-pricing/refresh/${jobId}`,
    onPhase,
    signal,
  );
  return result;
}
