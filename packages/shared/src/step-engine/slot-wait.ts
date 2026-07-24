/** Derivation of a task's "queued for a slot" state. A task whose step is parked waiting for
 *  capacity stays `running` in `tasks.status` — the orchestration guards, reapers and boot
 *  backstops all key on that value, so the wait is reported as a DERIVED field instead of a
 *  ninth task status. Being derived, it is recomputed from the live step rows on every poll
 *  and cannot go stale the way a written-on-park / forgotten-on-resume column would.
 *
 *  Two waits exist, both bounded by an admin cap:
 *    - runtime: the task-level runtime admission gate (MAX_CONCURRENT_RUNTIMES) parked the
 *      step before it could boot its DDEV/app runner. The worker resets the row to `pending`
 *      and stamps `waiting_started_at`, then re-drives it on a delayed poll.
 *    - agent:  the step's CLI invocation is enqueued but no worker slot has picked it up
 *      (MAX_PARALLEL_AGENTS) or it was deferred by the per-task cap
 *      (MAX_PARALLEL_AGENTS_PER_TASK).
 *
 *  Both signals are structural — a step status plus a marker column, or the existence of an
 *  unstarted invocation row. The park's `status_message` is display copy only; never branch
 *  on its text. */

export type SlotWaitKind = 'runtime' | 'agent';

/** A task step reduced to the fields the derivation needs. Date fields accept a `Date`
 *  (server-side Drizzle rows) or an ISO string (web JSON), like `TaskTimingStep`. */
export interface SlotWaitStep {
  /** Step ROW id (`task_steps.id`) — what a queued invocation points at. */
  id: string;
  stepId: string;
  round: number;
  status: string;
  waitingStartedAt: Date | string | null;
  statusMessage: string | null;
  updatedAt: Date | string | null;
}

export interface SlotWait {
  kind: SlotWaitKind;
  /** ISO time the wait began (the step's `waiting_started_at`), or null when unmarked. */
  since: string | null;
  /** Step the task is queued on, for the badge tooltip. */
  stepId: string;
  /** The worker's own park copy (e.g. "Waiting for a free runtime slot (limit 2; 1 ahead
   *  in the queue)"). Display only. */
  message: string | null;
  /** The park's own heartbeat has gone cold: the re-park rewrites `updated_at` on every
   *  poll, so a row older than `STALE_PARK_MS` means the poll loop is dead (crashed
   *  worker) and the task is WEDGED, not queued. Without this the badge would falsely
   *  reassure exactly when a task needs attention. */
  stale: boolean;
}

/** A runtime park re-writes `updated_at` once per poll: RUNTIME_PARK_POLL_MS (15s) of delay
 *  plus however long the admission re-check takes (a `docker ps` + Redis round trip), which
 *  measures ~30s end to end on a loaded host. 120s is ~4 of those periods — slack enough that
 *  a slow poll never cries "stalled" on a healthy task, tight enough to catch a dead worker
 *  within two minutes. */
export const STALE_PARK_MS = 120_000;

function toMs(v: Date | string | null): number | null {
  if (v == null) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

function toIso(v: Date | string | null): string | null {
  const ms = toMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}

/** The task's slot wait, or null when it is genuinely working (or not running at all).
 *
 *  Scoped to the task's CURRENT step (`current_step_id` + `current_round`): a park message
 *  and marker can survive on an older row (an earlier round parked, then the fix loop moved
 *  on), and reporting one of those would say "queued" about a task that is actively working
 *  somewhere else. */
export function deriveSlotWait(args: {
  taskStatus: string;
  currentStepId: string | null;
  currentRound: number;
  steps: readonly SlotWaitStep[];
  /** `task_steps.id` of every step holding an invocation that is enqueued but not started
   *  (started_at null, not ended, not superseded). */
  queuedInvocationStepRowIds: ReadonlySet<string>;
  nowMs: number;
}): SlotWait | null {
  // Only a live task can be queued. A Stopped/cancelled/failed task can leave a parked row
  // behind (its step is not always reset), and that must never read as "waiting for a slot".
  if (args.taskStatus !== 'running') return null;
  if (!args.currentStepId) return null;
  const row = args.steps.find(
    (s) => s.stepId === args.currentStepId && s.round === args.currentRound,
  );
  if (!row) return null;

  const since = toIso(row.waitingStartedAt);
  const updated = toMs(row.updatedAt);

  if (row.status === 'pending' && since !== null) {
    return {
      kind: 'runtime',
      since,
      stepId: row.stepId,
      message: row.statusMessage,
      stale: updated !== null && args.nowMs - updated > STALE_PARK_MS,
    };
  }
  if (row.status === 'waiting_cli' && args.queuedInvocationStepRowIds.has(row.id)) {
    // No staleness check: the agent wait is held by BullMQ, not by a polling loop that
    // touches the row, so `updated_at` says nothing about whether the queue is alive.
    return { kind: 'agent', since, stepId: row.stepId, message: row.statusMessage, stale: false };
  }
  return null;
}
