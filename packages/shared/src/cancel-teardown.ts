/** The cancellation re-drive window, also used by migration 0186's holder backfill.
 * Older cancellations may predate finish events and must not hold a checkout forever. */
export const CANCEL_REDRIVE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
