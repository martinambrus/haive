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

/** Minimum wait before a provider that returned 5xx is considered back. A rate limit states
 *  its own reset; a server error states nothing, and the usage endpoint that backs the probe
 *  below is a DIFFERENT surface from the inference endpoint that failed — it can answer fine
 *  while inference is still down. The cool-off is what stops that mismatch from declaring an
 *  instant, wrong recovery. */
export const SERVER_ERROR_COOLOFF_MS = 5 * 60_000;

/** How long a server-error watch keeps waiting before it is abandoned. A provider that has
 *  not answered in this long is an outage the user will have noticed; firing a "back online"
 *  notification (or worse, auto-resuming) a day later is noise, not help. */
export const SERVER_ERROR_WATCH_MAX_MS = 6 * 60 * 60_000;

export type ServerErrorVerdict =
  { back: false; giveUp: boolean } | { back: true; via: 'probe' | 'cooloff'; giveUp: false };

/** Decide whether a provider that failed with a 5xx is answering again.
 *
 *  There is no quota meter to read here, so recovery is judged two ways. For a CLI with a
 *  readable usage window the poller's own per-tick fetch IS a liveness probe: a snapshot with
 *  status 'ok' whose fetchedAt is LATER than the arm moment proves the vendor answered us
 *  after the failure. `fetchedAt > since` is the load-bearing half — a snapshot left over from
 *  before the outage is stale evidence and must not count. For a CLI with no usage window
 *  (amp, ollama, antigravity) no probe exists, so the cool-off elapsing is the whole verdict.
 *
 *  Either way the cool-off is a floor, and a watch older than SERVER_ERROR_WATCH_MAX_MS is
 *  abandoned rather than left to fire arbitrarily late. */
export function serverErrorVerdict(args: {
  since: Date | null;
  now: number;
  snapshot: { status: string; fetchedAt: Date } | null;
  hasUsageWindow: boolean;
}): ServerErrorVerdict {
  const { since, now, snapshot, hasUsageWindow } = args;
  // No arm time (a row written before the column existed) — nothing can be judged against it,
  // so abandon rather than guess a recovery.
  if (since == null) return { back: false, giveUp: true };
  const age = now - since.getTime();
  if (age < SERVER_ERROR_COOLOFF_MS) return { back: false, giveUp: false };
  if (!hasUsageWindow) return { back: true, via: 'cooloff', giveUp: false };
  if (snapshot?.status === 'ok' && snapshot.fetchedAt.getTime() > since.getTime()) {
    return { back: true, via: 'probe', giveUp: false };
  }
  return { back: false, giveUp: age > SERVER_ERROR_WATCH_MAX_MS };
}
