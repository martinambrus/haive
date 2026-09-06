/**
 * Busy span — the union of agent-busy intervals.
 *
 * Three different numbers describe "how long did this take", and conflating any two of them
 * produces nonsense:
 *
 *   - Agent-hours   Σ (end - start). Compute consumed. Counts overlap N times, on purpose.
 *   - Busy span     |∪ [start, end]|. Clock during which at least ONE agent was running.
 *   - Calendar span last end - first start. Includes the gaps where nothing ran.
 *
 * Steps of a task run one at a time, so `computeTaskTiming().workMs` bills a 400-agent
 * fan-out as one step's elapsed time; Σ duration bills it 400 times. MEASURED on a live
 * install: 63.64 agent-hours against a 17.42 h busy span (3.65x concurrent) inside a
 * 123.15 h calendar span (14.1% duty cycle).
 *
 * WHY THIS IS JS AND NOT SQL. The gaps-and-islands form (two window functions over a
 * LATERAL generate_series) is written and works — but `db.execute(sql\`...\`)` appears
 * nowhere in the api package and neither does any CTE or window function, so shipping it
 * would introduce the first raw statement there. This follows `computeTaskTiming` and
 * `buildEstimationAccuracy` instead: the api fetches and scopes, a pure function here does
 * the arithmetic, and it is unit-testable with no database. MEASURED, the SQL form is ~20 ms
 * at 1.5 K rows; a year at that rate is ~180 K narrow rows, which is a fetch worth measuring
 * and not worth pre-optimising.
 *
 * ONLY AGENT TIME CAN BE UNIONED. Invocations carry timestamps; `idle_ms`, `user_active_ms`
 * and the `carried_*` accumulators are client-posted DURATIONS with no location in time. We
 * know how long, never when. So effort (work + user) can be summed but never unioned, and
 * "effort per day" is not computable at all — it can only be attributed to a task and then
 * bucketed by that task's completion date. Deterministic step work (detect/apply with no CLI)
 * has no invocation row and is likewise outside the span; both are stated in the UI.
 */

/** An agent-busy interval. Dates accept a `Date` (server-side drizzle rows), an ISO string
 *  (web JSON) or epoch ms — the same latitude `TaskTimingStep` allows, for the same reason. */
export interface BusyInterval {
  start: Date | string | number | null;
  end: Date | string | number | null;
}

export interface BusySpanBucket {
  /** Local calendar day as `YYYY-MM-DD` in the requested zone. */
  bucket: string;
  busyMs: number;
  /** Contiguous runs of activity that touched this day. A run crossing midnight counts in
   *  both days, so these do NOT sum to `islands`. */
  islands: number;
}

export interface BusySpanResult {
  /** |∪ intervals| — the union, overlap counted once. */
  busyMs: number;
  /** Σ (end - start) — overlap counted every time. Agent-hours. */
  agentMs: number;
  /** last end - first start, gaps included. 0 when there are no usable intervals. */
  calendarMs: number;
  /** Contiguous runs of activity across the whole set. */
  islands: number;
  /** agentMs / busyMs — mean number of agents running while anything was running.
   *  null when nothing ran, rather than 0: "no concurrency" and "no data" are different. */
  concurrency: number | null;
  /** busyMs / calendarMs — the share of elapsed time anything was running.
   *  null when the calendar span is 0 (a single instant, or no data). */
  dutyCycle: number | null;
  /** Per local day, ascending. Empty when there are no usable intervals. */
  buckets: BusySpanBucket[];
}

const DAY_MS = 86_400_000;

/** Guard against a pathological interval producing an unbounded bucket walk. Ten years of
 *  daily buckets from one interval is already far past anything real. */
const MAX_BUCKET_STEPS = 4000;

function toMs(v: Date | string | number | null): number | null {
  if (v == null) return null;
  const t = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Cached because a formatter costs far more to construct than to use, and the bucket walk
 *  calls it several times per interval. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(ms: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // Some ICU versions render midnight as hour 24 under hour12:false.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's UTC offset in force at `ms`, in milliseconds.
 *
 *  Derived by rendering the instant in the zone and reading those wall-clock fields back as
 *  if they were UTC; the difference is the offset. This is the only way to get a zone's
 *  offset without a tz database dependency, and it is exact for every zone Intl knows. */
function offsetMsAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Offsets are whole minutes, so sub-second precision would only add noise.
  return asIfUtc - Math.floor(ms / 1000) * 1000;
}

/** Local calendar day of `ms` as `YYYY-MM-DD`. */
export function dayKey(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

/** The instant at which the local day containing `ms` ends.
 *
 *  Converting a wall clock back to an instant needs the offset in force AT THAT INSTANT, which
 *  is what we are solving for — so the offset at `ms` is the first guess and one correction
 *  settles it. Two passes is exactly enough: a DST change moves the boundary by the offset
 *  delta, and re-reading the offset at the corrected instant lands on the right side of it. */
function endOfLocalDay(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const wallNext = Date.UTC(p.year, p.month - 1, p.day + 1);
  const first = wallNext - offsetMsAt(ms, timeZone);
  return wallNext - offsetMsAt(first, timeZone);
}

/** Union / sum / calendar span of a set of agent-busy intervals, plus a per-local-day
 *  breakdown of the union.
 *
 *  Intervals need not be sorted. A null, unparseable, zero-length or inverted interval is
 *  DROPPED rather than clamped: a row whose clocks disagree is a row we cannot place, and
 *  inventing a zero-length one for it would inflate the island count.
 *
 *  Touching intervals ([a,b] and [b,c]) merge — the union of the two IS [a,c], and reporting
 *  two islands there would overstate how fragmented the work was. */
export function computeBusySpan(
  intervals: BusyInterval[],
  opts: { timeZone: string },
): BusySpanResult {
  const timeZone = opts.timeZone;
  const usable: Array<{ start: number; end: number }> = [];
  let agentMs = 0;
  for (const iv of intervals) {
    const start = toMs(iv.start);
    const end = toMs(iv.end);
    if (start === null || end === null || end <= start) continue;
    usable.push({ start, end });
    agentMs += end - start;
  }

  if (usable.length === 0) {
    return {
      busyMs: 0,
      agentMs: 0,
      calendarMs: 0,
      islands: 0,
      concurrency: null,
      dutyCycle: null,
      buckets: [],
    };
  }

  usable.sort((a, b) => a.start - b.start);

  // Sweep-merge into islands. `usable` is sorted by start, so an interval either extends the
  // open island or begins a new one; nothing earlier can reopen a closed island.
  const islands: Array<{ start: number; end: number }> = [];
  let cur = { start: usable[0]!.start, end: usable[0]!.end };
  for (let i = 1; i < usable.length; i++) {
    const iv = usable[i]!;
    if (iv.start <= cur.end) {
      if (iv.end > cur.end) cur.end = iv.end;
    } else {
      islands.push(cur);
      cur = { start: iv.start, end: iv.end };
    }
  }
  islands.push(cur);

  let busyMs = 0;
  const byBucket = new Map<string, { busyMs: number; islands: number }>();
  for (const island of islands) {
    busyMs += island.end - island.start;
    let at = island.start;
    for (let step = 0; at < island.end && step < MAX_BUCKET_STEPS; step++) {
      const boundary = endOfLocalDay(at, timeZone);
      // A boundary that fails to advance would spin; take the whole remainder instead so the
      // time is still counted, just against one day.
      const segmentEnd = boundary > at ? Math.min(boundary, island.end) : island.end;
      const key = dayKey(at, timeZone);
      const entry = byBucket.get(key) ?? { busyMs: 0, islands: 0 };
      entry.busyMs += segmentEnd - at;
      entry.islands += 1;
      byBucket.set(key, entry);
      at = segmentEnd;
    }
  }

  const calendarMs = islands[islands.length - 1]!.end - islands[0]!.start;
  const buckets = [...byBucket.entries()]
    .map(([bucket, v]) => ({ bucket, busyMs: v.busyMs, islands: v.islands }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

  return {
    busyMs,
    agentMs,
    calendarMs,
    islands: islands.length,
    concurrency: busyMs > 0 ? agentMs / busyMs : null,
    dutyCycle: calendarMs > 0 ? busyMs / calendarMs : null,
    buckets,
  };
}

/** Every local day in `[fromMs, toMs]`, ascending, so a chart can render an explicit zero for
 *  a day nothing ran instead of joining a line across the gap.
 *
 *  Bounded by MAX_BUCKET_STEPS for the same reason the walk above is. */
export function dayKeysBetween(fromMs: number, toMs: number, timeZone: string): string[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
  const keys: string[] = [];
  let at = fromMs;
  for (let step = 0; at <= toMs && step < MAX_BUCKET_STEPS; step++) {
    keys.push(dayKey(at, timeZone));
    const boundary = endOfLocalDay(at, timeZone);
    if (boundary <= at) break;
    at = boundary;
  }
  return keys;
}

export { DAY_MS as BUSY_SPAN_DAY_MS };
