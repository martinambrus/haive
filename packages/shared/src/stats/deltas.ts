/**
 * Period-over-period comparison, and the sample-count gate that decides whether a derived
 * statistic is worth showing at all.
 *
 * A number without a baseline is not an insight — "$94 spent" says nothing until it sits
 * beside last month's. And on a young install most derived figures are noise: MEASURED on the
 * dev install, 25 tasks, 11 completed, 1 review finding and 1 AI estimate. A "50% of findings
 * were refuted" built from two rows reads exactly like one built from two thousand, which is
 * the single most common way a statistics page misleads its owner. So the sample count travels
 * with the figure and the UI is expected to render the shortfall rather than the ratio.
 */

/** Below this many observations a derived RATIO is reported as insufficient rather than shown.
 *
 *  Five, not a larger textbook number: this is one developer's own tooling, not a population
 *  estimate, and a threshold high enough to be statistically respectable would blank the page
 *  for months. It is a guard against reading noise as signal, not a significance test. */
export const MIN_SAMPLES_FOR_TREND = 5;

export interface Delta {
  current: number;
  previous: number;
  /** (current - previous) / previous.
   *
   *  null when there is no baseline to divide by. Growth from zero is not "infinite percent"
   *  and not "100%"; it has no ratio, and `direction` is what carries the meaning there. */
  changeRatio: number | null;
  direction: 'up' | 'down' | 'flat';
}

export function computeDelta(current: number, previous: number): Delta {
  const cur = Number.isFinite(current) ? current : 0;
  const prev = Number.isFinite(previous) ? previous : 0;
  const direction = cur > prev ? 'up' : cur < prev ? 'down' : 'flat';
  return {
    current: cur,
    previous: prev,
    changeRatio: prev === 0 ? null : (cur - prev) / prev,
    direction,
  };
}

export interface RangeWindow {
  fromMs: number;
  toMs: number;
}

/** The equal-length window immediately before `range`, for a like-for-like comparison.
 *
 *  Equal LENGTH rather than "the previous calendar month": comparing a 31-day month against a
 *  28-day one reports a 10% swing that is nothing but the calendar. The cost is that the
 *  window can straddle month boundaries, which is the right trade for a range picker whose
 *  presets are "last 30 days", not "March". */
export function previousWindow(range: RangeWindow): RangeWindow {
  const span = Math.max(0, range.toMs - range.fromMs);
  return { fromMs: range.fromMs - span, toMs: range.fromMs };
}

export interface SampledRatio {
  /** The ratio itself. Present even when under-sampled, so a caller that wants it anyway
   *  (a tooltip, an export) can have it — but `sufficient` is what a headline must gate on. */
  ratio: number | null;
  /** Observations the ratio was computed from. */
  n: number;
  sufficient: boolean;
}

/** Build a ratio that carries its own sample count and whether that count is enough.
 *
 *  `denominator` is the sample count as well as the divisor: a rate over 3 rows is a rate over
 *  3 rows however impressive it looks. */
export function sampledRatio(
  numerator: number,
  denominator: number,
  minSamples: number = MIN_SAMPLES_FOR_TREND,
): SampledRatio {
  const n = Number.isFinite(denominator) && denominator > 0 ? denominator : 0;
  return {
    ratio: n > 0 ? numerator / n : null,
    n,
    sufficient: n >= minSamples,
  };
}

/** Whether a derived figure built from `n` observations should be shown as a trend. */
export function hasEnoughSamples(n: number, minSamples: number = MIN_SAMPLES_FOR_TREND): boolean {
  return Number.isFinite(n) && n >= minSamples;
}
