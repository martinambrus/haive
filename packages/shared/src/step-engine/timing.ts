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

/** Active-work / idle / user-active breakdown for a task, summed across its
 *  steps. Mirrors the per-step figures the task page shows: work is each step's
 *  wall-clock span minus its idle (time waiting on the user) minus the live open
 *  wait of a step still in `waiting_form`; a step that has not ended yet uses
 *  `nowMs` as its end. Pure, so the api list endpoint and the web detail page
 *  compute identical numbers. Wall clock (start -> end of the whole task) is the
 *  caller's job — it comes from the task row, not the steps. */
export function computeTaskTiming(steps: TaskTimingStep[], nowMs: number): TaskTiming {
  let workMs = 0;
  let idleMs = 0;
  let userActiveMs = 0;
  for (const s of steps) {
    const stepIdle = s.idleMs ?? 0;
    idleMs += stepIdle;
    userActiveMs += s.userActiveMs ?? 0;
    const start = toMs(s.startedAt);
    if (start === null) continue;
    const ended = toMs(s.endedAt);
    const end = ended ?? nowMs;
    const waitStart = toMs(s.waitingStartedAt);
    // A step sitting in waiting_form is accruing idle time right now; count the
    // ongoing wait so idle ticks live and is excluded from work below. On submit
    // the server folds this same span into idle_ms and clears waitingStartedAt,
    // so there is no double-count across the transition.
    const openWait =
      ended === null && s.status === 'waiting_form' && waitStart !== null
        ? Math.max(0, nowMs - waitStart)
        : 0;
    idleMs += openWait;
    workMs += Math.max(0, end - start - stepIdle - openWait);
  }
  return { workMs, idleMs, userActiveMs };
}
