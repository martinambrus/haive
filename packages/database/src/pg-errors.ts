/** Postgres SQLSTATE for unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when an error — or anything it wraps — is a Postgres unique_violation (23505).
 *
 * MUST walk the `cause` chain. drizzle-orm does not rethrow the driver error directly: it
 * throws a `DrizzleQueryError` whose own `.code` is `undefined` and whose `.cause` holds
 * the driver's `PostgresError` carrying the SQLSTATE. Verified against the live stack:
 *
 *   ctor=DrizzleQueryError code=undefined causeCtor=PostgresError causeCode=23505
 *
 * A shallow `err.code === '23505'` check therefore NEVER matches a real drizzle failure —
 * it silently rethrows and fails the caller instead of letting it treat the row as "a
 * concurrent writer won the race, park on theirs". That exact bug made the one-live-
 * per-step dispatch guards dead code from the day they were added.
 *
 * Depth-bounded so a cyclic `cause` chain cannot spin.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < 5; depth++) {
    if (
      typeof e === 'object' &&
      'code' in e &&
      (e as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
