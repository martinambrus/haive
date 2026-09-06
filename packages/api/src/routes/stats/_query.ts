import { isTaskClass, type TaskClass } from '@haive/shared/stats';
import { HttpError } from '../../context.js';

/** Window used when the caller names no range. Thirty days is the dashboard's fixed window,
 *  and the most common thing to want: long enough to smooth a quiet week, short enough that
 *  the previous-period comparison still describes the same working habits. */
export const DEFAULT_RANGE_DAYS = 30;

/** Longest range a single request may ask for.
 *
 *  Not arbitrary: the timeline endpoint fetches one narrow row per invocation across the
 *  window in order to compute the busy-span union in JS. MEASURED at ~515 invocations/day on
 *  a single-user install, so two years is ~375 K rows — already the point at which the fetch
 *  is the slowest thing in the request. A caller wanting more should ask for it in pieces, and
 *  will be told so rather than served a request that quietly takes a minute. */
export const MAX_RANGE_DAYS = 731;

const DAY_MS = 86_400_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StatsQuery {
  fromMs: number;
  toMs: number;
  /** IANA zone the day buckets are cut on. Validated against Intl, never trusted. */
  timeZone: string;
  repositoryId: string | null;
  cliProviderId: string | null;
  taskClass: TaskClass | null;
  /** Install-wide rather than just this user's rows. Admin only; the ROUTE enforces that,
   *  because this parser has no access to the caller's role. */
  allUsers: boolean;
}

export interface RawStatsQuery {
  from?: string | undefined;
  to?: string | undefined;
  tz?: string | undefined;
  repositoryId?: string | undefined;
  cliProviderId?: string | undefined;
  taskClass?: string | undefined;
  allUsers?: string | undefined;
}

/** Whether Intl recognises the zone.
 *
 *  Trying to construct a formatter is the only reliable test — there is no list to check
 *  against, and an unknown zone throws a RangeError rather than falling back to UTC. Letting
 *  that reach the day-bucket walk would throw from inside the aggregation with a message
 *  naming neither the zone nor the parameter. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseInstant(value: string, field: string): number {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new HttpError(400, `${field} must be an ISO 8601 timestamp`);
  }
  return ms;
}

function parseUuid(value: string | undefined, field: string): string | null {
  if (value === undefined || value === '') return null;
  if (!UUID_RE.test(value)) throw new HttpError(400, `${field} must be a UUID`);
  return value;
}

/** Parse the range/zone/facet query every statistics endpoint shares.
 *
 *  Hand-rolled rather than zod because that is what this package does for query strings (there
 *  is no `@hono/zod-validator` here), and pure + exported so it can be unit-tested without a
 *  request — the same shape as `parseInvocationHistoryQuery`.
 *
 *  `now` is injected so the default-range branch is testable; callers pass nothing. */
export function parseStatsQuery(raw: RawStatsQuery, now: number = Date.now()): StatsQuery {
  const toMs = raw.to !== undefined && raw.to !== '' ? parseInstant(raw.to, 'to') : now;
  const fromMs =
    raw.from !== undefined && raw.from !== ''
      ? parseInstant(raw.from, 'from')
      : toMs - DEFAULT_RANGE_DAYS * DAY_MS;

  if (fromMs > toMs) throw new HttpError(400, 'from must not be after to');
  if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) {
    throw new HttpError(400, `range must not exceed ${MAX_RANGE_DAYS} days`);
  }

  // UTC rather than the server's zone: a server-local default would silently re-bucket every
  // chart if the container's TZ ever changed, and the browser always sends its own zone.
  const timeZone = raw.tz !== undefined && raw.tz !== '' ? raw.tz : 'UTC';
  if (!isValidTimeZone(timeZone)) throw new HttpError(400, `tz is not a known IANA time zone`);

  let taskClass: TaskClass | null = null;
  if (raw.taskClass !== undefined && raw.taskClass !== '') {
    if (!isTaskClass(raw.taskClass)) throw new HttpError(400, 'taskClass is not a known class');
    taskClass = raw.taskClass;
  }

  return {
    fromMs,
    toMs,
    timeZone,
    repositoryId: parseUuid(raw.repositoryId, 'repositoryId'),
    cliProviderId: parseUuid(raw.cliProviderId, 'cliProviderId'),
    taskClass,
    allUsers: raw.allUsers === '1' || raw.allUsers === 'true',
  };
}
