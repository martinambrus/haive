/** Pure decision helper for the advance-step duplicate guard. Kept out of task-queue.ts so it
 *  unit-tests without pulling in BullMQ, the db, or the step registry. */
import { TASK_JOB_NAMES } from '@haive/shared';

/** Banner text for the step that is holding a task up. The other-step guard refuses to advance
 *  any step while one is still running/waiting_cli/waiting_form, and used to do it silently — the
 *  blocker kept displaying whatever it last said ("Waiting for AI analysis…") while the task sat
 *  dead, which is what made the freeze unreadable. Written onto the BLOCKER's row (the one the
 *  user is looking at) and cleared by the next normal transition. */
export function blockedByActiveStepMessage(blockedStepId: string): string {
  return (
    `Still active — an advance for "${blockedStepId}" was skipped. ` +
    'The task cannot move on until this step finishes or is stopped.'
  );
}

/** The slice of a BullMQ job the guard reads. */
export interface AdvanceJobRef {
  id?: string | null;
  name: string;
  data: { taskId?: string; stepId?: string; round?: number; epoch?: number | null };
}

/** Identity of the advance-step job asking whether it should yield. */
export interface AdvanceStepKey {
  jobId: string;
  taskId: string;
  stepId: string;
  round: number;
  epoch?: number | null;
}

/**
 * Find the advance-step job this one must yield to: same task + step + round + epoch, and a
 * LOWER job id so of two racing deliveries exactly one yields. Returns undefined when there is
 * nothing to yield to.
 *
 * `inFlightJobIds` is the set of job ids THIS worker process is currently executing, and it is
 * the load-bearing filter. BullMQ's `active` set is not proof of life: the task worker runs with
 * a 30-minute lockDuration (long step runs must survive a restart without redelivery), so a
 * worker killed mid-job leaves its jobs sitting in `active` for up to half an hour. Yielding to
 * one of those corpses froze the step for that whole window — every retry logged "same step
 * already running in another job" and did nothing. A job the local process is not running is
 * either dead or another replica's, and neither is a reason to stall.
 *
 * Single-replica assumption: docker-compose defines one `worker` service. If a second replica
 * ever runs, its jobs are invisible here, so the guard degrades to the pre-guard behaviour (two
 * concurrent applies) rather than to a freeze — the failure we actually hit, and the worse one.
 */
export function findLiveSibling(
  activeJobs: readonly AdvanceJobRef[],
  inFlightJobIds: ReadonlySet<string>,
  key: AdvanceStepKey,
): AdvanceJobRef | undefined {
  const epoch = key.epoch ?? null;
  return activeJobs.find((j) => {
    if (j.id == null || j.id === key.jobId) return false;
    if (j.name !== TASK_JOB_NAMES.ADVANCE_STEP) return false;
    if (!inFlightJobIds.has(j.id)) return false;
    if (Number(key.jobId) <= Number(j.id)) return false;
    return (
      j.data.taskId === key.taskId &&
      j.data.stepId === key.stepId &&
      (j.data.round ?? 0) === key.round &&
      (j.data.epoch ?? null) === epoch
    );
  });
}
