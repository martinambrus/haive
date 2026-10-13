/**
 * Range presets for the statistics page.
 *
 * Pure and separately tested because the web package has no jsdom and no component tests — the
 * same reason `format-stats.ts` exists.
 */

export type RangePresetId = '7d' | '30d' | '90d' | '1y' | 'all' | 'custom';

export interface ResolvedRange {
  fromMs: number;
  toMs: number;
}

const DAY_MS = 86_400_000;

/** Mirror of MAX_RANGE_DAYS in the api's stats query parser. Web keeps local copies of API
 *  constants rather than importing the @haive/shared barrel; the api rejects anything longer,
 *  so a mismatch here would produce a 400 the user cannot act on. Keep the two in sync. */
export const MAX_RANGE_DAYS = 731;

const PRESET_DAYS: Record<Exclude<RangePresetId, 'custom'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
  // "All" is bounded by what the API will serve. Labelled honestly rather than pretending to
  // be unbounded: the timeline endpoint fetches one row per invocation across the window.
  all: MAX_RANGE_DAYS,
};

export const RANGE_PRESETS: Array<{ id: RangePresetId; label: string; title?: string }> = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '1y', label: '1 year' },
  {
    id: 'all',
    label: 'All',
    title: `Everything the API will serve in one request (${MAX_RANGE_DAYS} days)`,
  },
  { id: 'custom', label: 'Custom' },
];

export function presetDays(id: RangePresetId): number | null {
  return id === 'custom' ? null : PRESET_DAYS[id];
}

/** The window a preset resolves to, ending at `now`. */
export function resolvePreset(id: Exclude<RangePresetId, 'custom'>, now: number): ResolvedRange {
  return { fromMs: now - PRESET_DAYS[id] * DAY_MS, toMs: now };
}

/** Whether a preset can show anything, given when the oldest data is.
 *
 *  A preset longer than the data's own span is not wrong, just identical to a shorter one — so
 *  it is offered but marked, rather than hidden. Hiding it would make the picker change shape
 *  as data accumulates, which reads as a bug. `null` (span unknown) leaves everything enabled. */
export function presetIsRedundant(
  id: RangePresetId,
  oldestMs: number | null,
  now: number,
): boolean {
  if (id === 'custom' || oldestMs == null) return false;
  const spanDays = (now - oldestMs) / DAY_MS;
  return PRESET_DAYS[id] > spanDays;
}

/** Parse the two `datetime-local` inputs into a range.
 *
 *  Returns null when either side is missing or unparseable, or the range is inverted — the
 *  caller keeps showing the previous range rather than requesting something the API will
 *  reject. `new Date('2026-09-01T00:00')` is interpreted in the BROWSER's zone, which is what
 *  a person picking a local time means. */
export function parseCustomRange(from: string, to: string): ResolvedRange | null {
  if (!from || !to) return null;
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  if (fromMs > toMs) return null;
  if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) return null;
  return { fromMs, toMs };
}

/** An epoch ms as the `YYYY-MM-DDTHH:mm` a `datetime-local` input expects, in local time.
 *
 *  `toISOString()` would be UTC and silently shift the value the user sees by their offset. */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isRangePresetId(v: unknown): v is RangePresetId {
  return typeof v === 'string' && RANGE_PRESETS.some((p) => p.id === v);
}
