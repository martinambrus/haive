import { HttpError } from '../../context.js';

/** How many COMPLETED runs one page of a step's terminal history carries when the
 *  caller names no limit. A step can accumulate hundreds of invocations (156 on the
 *  dev install's worst step) and the web UI mounts one xterm per expanded run, so an
 *  unbounded list was megabytes of output and hundreds of terminals in one render. */
export const DEFAULT_INVOCATION_HISTORY_LIMIT = 20;

/** Upper bound a caller may ask for. Deliberately modest: the point of the page is
 *  that the browser never holds the whole history at once. */
export const MAX_INVOCATION_HISTORY_LIMIT = 100;

/** A UUID, loosely — enough to reject a cursor that is not an id before it reaches
 *  Postgres, which errors on a malformed uuid literal rather than returning no rows. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InvocationHistoryQuery {
  /** Completed rows to return in this page. ACTIVE rows are always returned in full
   *  on top of this — a live terminal must never be paged away. */
  limit: number;
  /** Id of the oldest completed row the caller already holds; this page starts
   *  strictly older than it. Null for the head page. */
  cursor: string | null;
}

/** Parse the `historyLimit` / `historyCursor` query pair.
 *
 *  The cursor is an invocation ID rather than an encoded `(created_at, id)` tuple on
 *  purpose. `created_at` is `timestamp` (microsecond precision) while a JS `Date`
 *  round-trip truncates to milliseconds, so a tuple rebuilt from a fetched row would
 *  compare against a value the database never stored — silently skipping or repeating
 *  every row that shares the truncated millisecond. Resolving the tuple back out of the
 *  row inside the query (see the keyset in steps.ts) keeps full precision.
 *
 *  `created_at` alone is not a key either: it defaults to `now()`, which is the
 *  TRANSACTION timestamp, so a fan-out that inserts its invocations in one transaction
 *  gives every row the same value. Hence the compound `(created_at, id)` order. */
export function parseInvocationHistoryQuery(raw: {
  historyLimit?: string | undefined;
  historyCursor?: string | undefined;
}): InvocationHistoryQuery {
  let limit = DEFAULT_INVOCATION_HISTORY_LIMIT;
  if (raw.historyLimit !== undefined && raw.historyLimit !== '') {
    const n = Number(raw.historyLimit);
    if (!Number.isInteger(n) || n < 0 || n > MAX_INVOCATION_HISTORY_LIMIT) {
      throw new HttpError(
        400,
        `historyLimit must be an integer between 0 and ${MAX_INVOCATION_HISTORY_LIMIT}`,
      );
    }
    limit = n;
  }
  let cursor: string | null = null;
  if (raw.historyCursor !== undefined && raw.historyCursor !== '') {
    if (!UUID_RE.test(raw.historyCursor)) throw new HttpError(400, 'historyCursor must be a UUID');
    cursor = raw.historyCursor;
  }
  return { limit, cursor };
}
