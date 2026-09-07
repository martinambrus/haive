import type { StatsTimelineDay } from '@/lib/api-client';

/**
 * The arithmetic behind the activity heatmap: which shade a day gets, and how the days lay out
 * on a calendar.
 *
 * A pure sibling for the same reason `format-stats.ts` is one — the web package has no jsdom
 * and no testing-library, so anything worth asserting has to live outside a component.
 */

/** What a cell measures. Every one of these is already on `StatsTimelineDay` and is currently
 *  computed by the API and thrown away by the page. */
export type HeatMetric = 'agent' | 'invocations' | 'completed' | 'spend';

export const HEAT_METRICS: Array<{ id: HeatMetric; label: string }> = [
  { id: 'agent', label: 'Agent-hours' },
  { id: 'invocations', label: 'Runs' },
  { id: 'completed', label: 'Tasks done' },
  { id: 'spend', label: 'Spend' },
];

export function isHeatMetric(v: unknown): v is HeatMetric {
  return HEAT_METRICS.some((m) => m.id === v);
}

/** The metric's raw value for one day. Spend is real plus counterfactual on purpose: the cell
 *  asks "how much did this day cost to run", which on a flat plan is entirely the second half. */
export function heatValue(day: StatsTimelineDay, metric: HeatMetric): number {
  switch (metric) {
    case 'agent':
      return day.agentMs;
    case 'invocations':
      return day.invocations;
    case 'completed':
      return day.tasksCompleted;
    case 'spend':
      return day.realUsd + day.notionalUsd;
  }
}

/**
 * The three cut points that split the worked days into four shades.
 *
 * Quantiles of the NON-ZERO days, by nearest rank, so every threshold is a value that was
 * actually observed. Two alternatives were rejected on measurement of the real day series
 * (agent-hours 44.76, 20.78, 16.36, 15.87, 13.19, 12.61, 8.35): dividing by the maximum puts
 * five of those seven days under 0.37, and a fixed 0.3/0.6 threshold on that normalised value
 * then lands three of them in one shade and one in another. A skewed series is the normal case
 * here — one long day sets the maximum and flattens the rest of the week against it.
 *
 * Zero days are excluded from the quantiles because they are not a quartile of anything; they
 * get their own shade (step 0) so "nothing ran" never reads as "a quiet day".
 */
export function heatThresholds(values: number[]): number[] {
  const worked = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (worked.length === 0) return [];
  const at = (p: number) => worked[Math.min(worked.length - 1, Math.ceil(p * worked.length) - 1)]!;
  return [at(0.25), at(0.5), at(0.75)];
}

/** Which shade a value gets: 0 = nothing ran, 1..4 = the ramp, darkest last.
 *
 *  A window in which every worked day carries the SAME value collapses all three thresholds
 *  onto it, so every one of those days is step 4. That is the honest reading — each of them is
 *  the busiest day in the window — and, more importantly, it is uniform: the failure to avoid
 *  is two identical days rendering as two different shades. */
export function heatStep(value: number, thresholds: number[]): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (thresholds.length < 3) return 4;
  if (value >= thresholds[2]!) return 4;
  if (value >= thresholds[1]!) return 3;
  if (value >= thresholds[0]!) return 2;
  return 1;
}

/** One cell of a month grid. `bucket` is null for the pad cells that align the first of the
 *  month under its weekday — those render as a hole, not as a day with no work. */
export interface CalendarCell {
  bucket: string | null;
  dayOfMonth: number;
}

export interface MonthGrid {
  /** `YYYY-MM`, for a stable React key. */
  key: string;
  /** e.g. `Sep 2026`. */
  label: string;
  /** Weeks of exactly seven cells, Monday first. */
  weeks: CalendarCell[][];
}

/** Monday-first, because the working week is what this grid is about. */
export const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

const BUCKET_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A bucket key parsed at UTC noon.
 *
 *  The key is ALREADY a local calendar day in the viewer's zone (the API cut it there), so
 *  re-parsing it must not let an offset shift it back a day. Noon is far enough from either
 *  boundary that no offset on earth can cross it — the same trick `formatBucketLabel` uses. */
function parseBucket(bucket: string): { y: number; m: number; d: number } | null {
  const m = BUCKET_RE.exec(bucket);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function monthLabel(y: number, m: number): string {
  return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Lay the window's day keys out as one grid per calendar month.
 *
 * Every day of a touched month gets a cell, including days the window does not cover — the
 * caller distinguishes them by looking the bucket up in its own day map, so a partial first
 * month renders as a real calendar rather than as a ragged run of squares.
 *
 * Built entirely from the bucket strings. Nothing here reads `Date.now()` or the ambient zone,
 * so it renders identically on the server and in the browser.
 */
export function calendarMonths(buckets: string[]): MonthGrid[] {
  const parsed = buckets
    .map(parseBucket)
    .filter((p): p is { y: number; m: number; d: number } => p !== null);
  if (parsed.length === 0) return [];

  const months = new Map<string, { y: number; m: number }>();
  for (const p of parsed) {
    months.set(`${p.y}-${String(p.m).padStart(2, '0')}`, { y: p.y, m: p.m });
  }

  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { y, m }]) => {
      // Day 0 of the next month is the last day of this one.
      const daysInMonth = new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
      // getUTCDay is Sunday-based; shift so Monday is 0.
      const lead = (new Date(Date.UTC(y, m - 1, 1, 12)).getUTCDay() + 6) % 7;

      const cells: CalendarCell[] = [];
      for (let i = 0; i < lead; i++) cells.push({ bucket: null, dayOfMonth: 0 });
      for (let d = 1; d <= daysInMonth; d++) {
        cells.push({
          bucket: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
          dayOfMonth: d,
        });
      }
      while (cells.length % 7 !== 0) cells.push({ bucket: null, dayOfMonth: 0 });

      const weeks: CalendarCell[][] = [];
      for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
      return { key, label: monthLabel(y, m), weeks };
    });
}

/** The UTC offset in force at an instant, in ms. `longOffset` yields a bare `GMT` for zero,
 *  which the regex misses and which is correctly read as 0. */
function offsetMsAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(ms));
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  const magnitude = Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000;
  return m[1] === '-' ? -magnitude : magnitude;
}

/** The instant at which a local wall-clock midnight occurs.
 *
 *  Converting a wall clock back to an instant needs the offset in force AT THAT INSTANT, which
 *  is the thing being solved for — so the offset at the naive guess is the first approximation
 *  and one correction settles it. Two passes is exactly enough: a DST change moves the boundary
 *  by the offset delta, and re-reading the offset at the corrected instant lands on the right
 *  side of it. (The same argument, and the same shape, as `endOfLocalDay` in
 *  `@haive/shared/stats` — duplicated rather than imported because web must not pull that
 *  barrel into the bundle, and because this is the INVERSE direction: shared cuts days out of
 *  instants, this turns a day back into one.) */
function localMidnight(y: number, m: number, d: number, timeZone: string): number {
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offsetMsAt(wall, timeZone);
  return wall - offsetMsAt(first, timeZone);
}

/** The half-open instant range `[start, end)` covered by one local calendar day.
 *
 *  Used to narrow a drill-through to the day a heat cell represents. Returns null for a
 *  malformed key rather than a range built from NaN, so the caller can fall back to the whole
 *  window instead of linking at an invalid one. */
export function localDayRange(
  bucket: string,
  timeZone: string,
): { fromMs: number; toMs: number } | null {
  const p = parseBucket(bucket);
  if (!p) return null;
  const fromMs = localMidnight(p.y, p.m, p.d, timeZone);
  const toMs = localMidnight(p.y, p.m, p.d + 1, timeZone);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  return { fromMs, toMs };
}
