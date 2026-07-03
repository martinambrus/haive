/** Pure snapshot-interpretation helpers for the allowance-back watch (notify-only).
 *  Shared by the arm path (task-queue's `failed` handler captures the reset the task is
 *  blocked until) and the detect path (usage-poll's tick decides when allowance is back).
 *  DOM/db-free so it unit-tests trivially. All *Pct values are 0-100 percent CONSUMED,
 *  mirroring `usage_window_snapshots`; a null window means the vendor doesn't expose it. */

/** A window is treated as the blocker when consumed >= this. The task literally hit the
 *  limit, so the constraining window sits at/near 100; 90 is a safe floor against skew. */
export const EXHAUSTED_PCT = 90;

/** Allowance is "back" once the max consumed window falls below this. Hysteresis under
 *  EXHAUSTED_PCT so a reading hovering at the cap can't flap armed<->replenished. */
export const RECOVERED_PCT = 80;

/** The three usage windows as stored on a `usage_window_snapshots` row (Date | null). */
export interface UsageWindows {
  fiveHourPct: number | null;
  fiveHourResetAt: Date | null;
  sevenDayPct: number | null;
  sevenDayResetAt: Date | null;
  dailyPct: number | null;
  dailyResetAt: Date | null;
}

/** Max consumed % across the exposed windows; null when the vendor exposes none. */
export function maxConsumedPct(w: UsageWindows): number | null {
  const pcts = [w.fiveHourPct, w.sevenDayPct, w.dailyPct].filter((p): p is number => p != null);
  return pcts.length ? Math.max(...pcts) : null;
}

/** The LATEST reset among the windows currently at/over EXHAUSTED_PCT — the true "blocked
 *  until" moment (if both the 5-hour and 7-day windows are maxed you're unblocked only when
 *  the later one resets). Null when no window is constrained or none exposes a reset. */
export function constrainingResetAt(w: UsageWindows): Date | null {
  const resets = [
    [w.fiveHourPct, w.fiveHourResetAt],
    [w.sevenDayPct, w.sevenDayResetAt],
    [w.dailyPct, w.dailyResetAt],
  ]
    .filter(([pct, reset]) => pct != null && (pct as number) >= EXHAUSTED_PCT && reset != null)
    .map(([, reset]) => reset as Date);
  if (!resets.length) return null;
  return resets.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

export type AllowanceVerdict = { back: false } | { back: true; via: 'reset' | 'usage_dropped' };

/** Decide whether a depleted allowance is back, given the reset captured at arm time and the
 *  current snapshot. `reset` (the vendor's stated reset having passed) is authoritative and
 *  wins; the %-recovered path covers providers that expose no reset (e.g. zai) and early
 *  recovery. `snapshotOk` gates the %-path so a stale/errored snapshot can't recover a task
 *  off old numbers — but a passed reset still fires (it doesn't depend on live %). */
export function allowanceVerdict(args: {
  resetAt: Date | null;
  windows: UsageWindows | null;
  snapshotOk: boolean;
  now: number;
}): AllowanceVerdict {
  const { resetAt, windows, snapshotOk, now } = args;
  if (resetAt != null && now >= resetAt.getTime()) return { back: true, via: 'reset' };
  const maxPct = windows && snapshotOk ? maxConsumedPct(windows) : null;
  if (maxPct != null && maxPct < RECOVERED_PCT) return { back: true, via: 'usage_dropped' };
  return { back: false };
}
