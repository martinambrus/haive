/**
 * Per-task breakdown of a window's agent time.
 *
 * The window-level figures (`computeBusySpan` over every invocation) say how much agent time a
 * range consumed; this says which tasks it went into. The union rule is not re-implemented — the
 * intervals are partitioned by task and `computeBusySpan` is called once per partition, so there
 * remains exactly one definition of agent-hours, busy span and calendar span.
 *
 * TWO SUMS BEHAVE DIFFERENTLY, and the difference is the reason this is worth stating rather
 * than assuming. Agent-hours is Σ (end - start), which is partition-invariant: the per-task
 * numbers add up to the window total exactly. Busy span is |∪ intervals|, which is NOT — two
 * tasks running the same hour each report that hour, while the window reports it once. So
 * Σ per-task busyMs >= the window's busyMs, always, and a UI that shows both must say so.
 *
 * Sorted by agent-hours because that is the question the table answers ("where did the compute
 * go"), and capped because a two-year window on a busy install has more tasks than anyone will
 * read. The cap is applied AFTER the sort, so it drops the smallest consumers, and the caller is
 * told it happened — a partial sum presented as a total is worse than no table.
 */

import { computeBusySpan, type BusyInterval } from './busy-span.js';

/** An agent-busy interval carrying the task it belongs to. */
export interface TaskBusyInterval extends BusyInterval {
  taskId: string;
}

export interface TaskTimeRow {
  taskId: string;
  /** Invocations recorded for this task in the window. */
  invocations: number;
  /** Σ (end - start) — overlap counted every time. Agent-hours. */
  agentMs: number;
  /** |∪ intervals| for THIS task alone. Does not sum across tasks; see the header. */
  busyMs: number;
  /** last end - first start for this task, gaps included. */
  calendarMs: number;
  /** Contiguous runs of activity. */
  islands: number;
  /** agentMs / busyMs. null when nothing usable ran, rather than 0. */
  concurrency: number | null;
  /** busyMs / calendarMs. null when the calendar span is 0. */
  dutyCycle: number | null;
}

export interface TaskTimeBreakdown {
  /** Sorted by agentMs desc, then capped. */
  rows: TaskTimeRow[];
  /** Distinct tasks BEFORE the cap, so a truncated page can name what it left out. */
  taskCount: number;
  truncated: boolean;
}

/** Rows a single request returns. Generous — a 30-day window on a single-user install produces
 *  tens — so the cap is a guard against a two-year range, not a page size. */
export const TASK_TIME_ROW_LIMIT = 200;

/** Group agent-busy intervals by task, rank by agent-hours, cap and report the cap.
 *
 *  A task whose intervals are all unusable (unparseable, zero-length or inverted — the set
 *  `computeBusySpan` drops) still appears, with zeroed timings and its raw `invocations` count.
 *  Dropping the task entirely would make it invisible in a table whose whole job is to account
 *  for the window, and "ran, measured nothing" is a different fact from "did not run". */
export function buildTaskTimeBreakdown(
  intervals: TaskBusyInterval[],
  opts: { timeZone: string; limit?: number },
): TaskTimeBreakdown {
  const byTask = new Map<string, BusyInterval[]>();
  for (const iv of intervals) {
    const list = byTask.get(iv.taskId);
    if (list) list.push({ start: iv.start, end: iv.end });
    else byTask.set(iv.taskId, [{ start: iv.start, end: iv.end }]);
  }

  const rows: TaskTimeRow[] = [];
  for (const [taskId, list] of byTask) {
    const span = computeBusySpan(list, { timeZone: opts.timeZone });
    rows.push({
      taskId,
      invocations: list.length,
      agentMs: span.agentMs,
      busyMs: span.busyMs,
      calendarMs: span.calendarMs,
      islands: span.islands,
      concurrency: span.concurrency,
      dutyCycle: span.dutyCycle,
    });
  }

  // Tie-broken down to the id so a cap always cuts the same rows: two tasks with identical
  // timings must not swap places between two requests for the same window.
  rows.sort((a, b) => {
    if (b.agentMs !== a.agentMs) return b.agentMs - a.agentMs;
    if (b.busyMs !== a.busyMs) return b.busyMs - a.busyMs;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });

  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : TASK_TIME_ROW_LIMIT;
  return {
    rows: rows.length > limit ? rows.slice(0, limit) : rows,
    taskCount: rows.length,
    truncated: rows.length > limit,
  };
}
