import type { SampledRatio, StatsDelta } from '@/lib/api-client';

/**
 * Formatting for statistics figures.
 *
 * Extracted into a pure module rather than written inline in the page because the web package
 * has no jsdom, no testing-library and no vitest config — component tests are impossible here,
 * so anything worth asserting has to live in a sibling `.ts` (the same reason `step-banners.ts`
 * and `plan-tree-filter.ts` exist).
 *
 * The rule every function here follows: a figure that cannot be computed renders as an em dash,
 * never as zero. "Nothing ran" and "we have no baseline" are different claims, and a KPI tile
 * that shows 0% for both is lying about one of them.
 */

const DASH = '—';

/** A ratio as a percentage. `null` (no data) renders as a dash, not 0%. */
export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio == null || !Number.isFinite(ratio)) return DASH;
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** A signed percentage for a period-over-period change. */
export function formatDeltaPercent(delta: StatsDelta | null | undefined): string {
  if (!delta) return DASH;
  if (delta.changeRatio == null) {
    // No baseline to divide by. "New" says what actually happened; "+100%" and "+∞%" would
    // both be inventions.
    return delta.current > 0 ? 'new' : DASH;
  }
  const pct = delta.changeRatio * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
}

/** Tailwind text colour for a delta, given whether growth is good.
 *
 *  Direction alone does not say whether a change is welcome: more tasks completed is good,
 *  more money spent is not. The caller states the polarity rather than this module guessing. */
export function deltaToneClass(
  delta: StatsDelta | null | undefined,
  moreIsBetter: boolean,
): string {
  if (!delta || delta.direction === 'flat') return 'text-neutral-500';
  const good = delta.direction === 'up' ? moreIsBetter : !moreIsBetter;
  return good ? 'text-emerald-400' : 'text-amber-400';
}

/** Agent-hours. Deliberately NOT formatDuration: this is compute consumed, not elapsed time,
 *  and rendering it as "2h 13m" invites reading it as a duration it is not. */
export function formatAgentHours(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return DASH;
  const hours = ms / 3_600_000;
  if (hours === 0) return '0 ah';
  if (hours < 10) return `${hours.toFixed(2)} ah`;
  return `${hours.toFixed(1)} ah`;
}

/** The concurrency factor: mean agents running while anything was running. */
export function formatConcurrency(factor: number | null | undefined): string {
  if (factor == null || !Number.isFinite(factor)) return DASH;
  return `${factor.toFixed(2)}×`;
}

/** A ratio that carries its own sample count.
 *
 *  Under the threshold the count is shown INSTEAD of the percentage. This is the single most
 *  important formatting rule on the page: with 25 tasks and 1 review finding on a real
 *  install, a percentage from two rows reads exactly like one from two thousand. */
export function formatSampledRatio(r: SampledRatio | null | undefined, digits = 0): string {
  if (!r || r.ratio == null) return DASH;
  if (!r.sufficient) return `n=${r.n}`;
  return formatPercent(r.ratio, digits);
}

/** Whether the caller should render the "too few to trend" hint beside a figure. */
export function isUnderSampled(r: SampledRatio | null | undefined): boolean {
  return !!r && r.ratio != null && !r.sufficient;
}

/** A count with thousands separators; nullish renders as a dash. */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return n.toLocaleString();
}

/** `2026-09-06` -> `6 Sep`, for a dense chart axis.
 *
 *  Parsed as UTC noon rather than midnight: the bucket key is already a LOCAL calendar day in
 *  the viewer's zone, so re-parsing it must not let a timezone offset shift it back a day.
 *  Noon is far enough from either boundary that no offset on earth can cross it. */
export function formatBucketLabel(bucket: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket);
  if (!m) return bucket;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export { DASH as STATS_DASH };
