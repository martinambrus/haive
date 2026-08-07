import { api, type CliProbeResult } from './api-client.js';

/** What a running "Test connection" is doing right now, for the button label.
 *
 *  `queued` is the state this whole polling path exists for: a probe shares `cli-exec-queue`
 *  with agent invocations and cannot preempt one, so waiting minutes behind multi-minute CLI
 *  runs is normal operation, not a failure. Showing it as its own phase is the difference
 *  between "the machine is busy" and the 504 this replaced, which read as "provider broken". */
export type CliProbePhase = 'queued' | 'running';

/** Map a BullMQ job state to the two phases the UI distinguishes.
 *
 *  Only `active` means a worker holds the job. `waiting`, `prioritized` and `delayed` are all
 *  just different ways of waiting for a slot, so they collapse into one user-facing phase. */
export function probePhaseForState(state: string | undefined): CliProbePhase {
  return state === 'active' ? 'running' : 'queued';
}

const POLL_INTERVAL_MS = 2_000;

/** How long the browser keeps polling before handing the wait back to the user. Must stay
 *  under the server's PROBE_JOB_RETENTION_S (packages/api/src/routes/cli-providers.ts) so a
 *  finished result is never reaped out from under a poll that is still running. */
export const PROBE_POLL_TIMEOUT_MS = 10 * 60 * 1000;

const STILL_QUEUED_MESSAGE =
  'Still queued behind running CLI jobs. The probe keeps going in the background and writes ' +
  'the auth status when it finishes — reopen this page later to see the result.';

type ProbeStatusResponse =
  | { status: 'pending'; state?: string }
  | { status: 'done'; result: CliProbeResult }
  | { status: 'failed'; error: string };

/** Queue a provider probe and poll until it finishes.
 *
 *  Resolves with the probe result, or throws with a message fit to show the user: a failed
 *  probe's reason, an expired job, or the still-queued notice once the poll window is spent.
 *  Giving up polling does NOT cancel the probe — it runs to completion server-side either way. */
export async function runCliProbe(
  providerId: string,
  onPhase?: (phase: CliProbePhase) => void,
): Promise<CliProbeResult> {
  const { jobId } = await api.post<{ jobId: string }>(`/cli-providers/${providerId}/test`);
  onPhase?.('queued');

  const deadline = Date.now() + PROBE_POLL_TIMEOUT_MS;
  for (;;) {
    const res = await api.get<ProbeStatusResponse>(`/cli-providers/${providerId}/test/${jobId}`);
    if (res.status === 'done') return res.result;
    if (res.status === 'failed') throw new Error(res.error);

    onPhase?.(probePhaseForState(res.state));
    if (Date.now() >= deadline) throw new Error(STILL_QUEUED_MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
