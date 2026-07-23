/** A task step reduced to just the fields the timing breakdown needs. Date
 *  fields accept a `Date` (server-side Drizzle rows) or an ISO string (web JSON)
 *  so both callers can pass their native shape. */
export interface TaskTimingStep {
  startedAt: Date | string | null;
  endedAt: Date | string | null;
  idleMs: number | null;
  userActiveMs: number | null;
  waitingStartedAt: Date | string | null;
  status: string;
  /** Work / idle / user-active (ms) folded in from PRIOR runs of this step by a
   *  retry/revise/reset, added on top of the current run below. Optional so a caller
   *  that has not selected the columns (treated as 0) still satisfies the shape. */
  carriedWorkMs?: number | null;
  carriedIdleMs?: number | null;
  carriedUserActiveMs?: number | null;
}

export interface TaskTiming {
  /** Sum of every step's active-work span (wall minus idle minus open wait). */
  workMs: number;
  /** Sum of idle time (each step's time waiting on the user). */
  idleMs: number;
  /** Sum of user-active time (the focused subset of idle, at gates). */
  userActiveMs: number;
}

function toMs(v: Date | string | null): number | null {
  if (v == null) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Work / idle / user-active the CURRENT run of one step contributes, using the
 *  rule the task page shows: work is the step's span (start -> ended, or `nowMs` if
 *  still open) minus its idle and minus the live open wait; idle is stored idle plus
 *  that open wait; user-active is the stored focused subset. A step with no
 *  `startedAt` contributes no work but still surfaces any stored idle/user (matches
 *  the historical sum). Pure — shared by `computeTaskTiming` (read path) and the
 *  reset fold (which snapshots a finishing run before its timing is zeroed).
 *
 *  `foldSit` (reset fold only): also count a FAILED step's ended -> now dead-wait as
 *  idle, so retrying after a failure (e.g. a rate-limit sit) attributes that wait to
 *  the step and `carried_work + carried_idle` equals the full attempt span. Off on
 *  the read path, so viewing a failed task is unchanged. */
export function computeStepContribution(
  step: TaskTimingStep,
  nowMs: number,
  foldSit = false,
): TaskTiming {
  const stepIdle = step.idleMs ?? 0;
  const userActiveMs = step.userActiveMs ?? 0;
  const start = toMs(step.startedAt);
  if (start === null) return { workMs: 0, idleMs: stepIdle, userActiveMs };
  const ended = toMs(step.endedAt);
  const end = ended ?? nowMs;
  const waitStart = toMs(step.waitingStartedAt);
  // A step accruing non-work wait right now: either sitting in waiting_form (waiting on
  // the user) or parked in waiting_cli with NO invocation currently running (waiting on a
  // CLI slot / a rate-limit reset). Count the ongoing wait so idle ticks live and is
  // excluded from work below. waitingStartedAt is the invariant: for waiting_cli the worker
  // sets it only while no invocation runs and clears+folds it into idle_ms when one starts,
  // so an actively-running CLI step has waitStart === null and its span still bills as work.
  // On the fold the server adds this same span to idle_ms and clears waitingStartedAt, so
  // there is no double-count across the transition.
  const openWait =
    ended === null &&
    (step.status === 'waiting_form' || step.status === 'waiting_cli') &&
    waitStart !== null
      ? Math.max(0, nowMs - waitStart)
      : 0;
  const sit =
    foldSit && ended !== null && step.status === 'failed' ? Math.max(0, nowMs - ended) : 0;
  return {
    workMs: Math.max(0, end - start - stepIdle - openWait),
    idleMs: stepIdle + openWait + sit,
    userActiveMs,
  };
}

/** Work / idle / user-active one step contributes when it is being RESET and FOLDED into
 *  carried_* (not displayed live). Identical to the read path for a step whose run has ENDED
 *  (or is a waiting park), so a normal reset is unchanged. The one difference is a run still
 *  OPEN at fold time — endedAt null with a started_at, e.g. a step left `running` after a
 *  worker restart orphaned it. computeStepContribution bills such a step's whole start->now
 *  gap as work; for an orphaned step that gap is hours or days of DEAD time, not work, and
 *  folding it inflates carried_work permanently (observed: a task reported 157h of "work",
 *  149h of which was one never-completed step's orphan gap). So an open run's billed work is
 *  reclassified as idle here. A genuinely-running step being revised loses at most its brief
 *  current run to idle and re-runs anyway; the live read path is untouched and keeps ticking
 *  work for a running step. Used by every carried_* fold (reset/revise/retry) so the rule
 *  lives in ONE place instead of being duplicated across the worker + api reset sites. */
export function computeFoldContribution(step: TaskTimingStep, nowMs: number): TaskTiming {
  const c = computeStepContribution(step, nowMs, step.status === 'failed');
  const open = toMs(step.startedAt) !== null && toMs(step.endedAt) === null;
  if (!open) return c;
  return { workMs: 0, idleMs: c.idleMs + c.workMs, userActiveMs: c.userActiveMs };
}

/** Active-work / idle / user-active breakdown for a task, summed across its steps.
 *  Each step's CURRENT run (via `computeStepContribution`) plus any timing carried
 *  over from prior runs (`carried_*`, folded in by a retry/reset), so the totals
 *  report the full step across all restarts, not just the latest attempt. Pure, so
 *  the api list endpoint and the web detail page compute identical numbers. Wall
 *  clock (start -> end of the whole task) is the caller's job — it comes from the
 *  task row, not the steps. */
export function computeTaskTiming(steps: TaskTimingStep[], nowMs: number): TaskTiming {
  let workMs = 0;
  let idleMs = 0;
  let userActiveMs = 0;
  for (const s of steps) {
    const c = computeStepContribution(s, nowMs);
    workMs += c.workMs + (s.carriedWorkMs ?? 0);
    idleMs += c.idleMs + (s.carriedIdleMs ?? 0);
    userActiveMs += c.userActiveMs + (s.carriedUserActiveMs ?? 0);
  }
  return { workMs, idleMs, userActiveMs };
}
