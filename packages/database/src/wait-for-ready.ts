import { sql } from 'drizzle-orm';
import type { Database } from './index.js';

// Postgres SQLSTATEs that mean "reachable but not ready yet" — retry these.
const TRANSIENT_PG_CODES = new Set([
  '57P03', // cannot_connect_now — "the database system is starting up"
  '57P01', // admin_shutdown — server shutting down
  '08006', // connection_failure
  '08001', // unable to establish connection
  '08004', // connection rejected
]);
// Socket-level errors from postgres.js when the TCP endpoint is not up yet.
const TRANSIENT_NET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function shortReason(err: unknown): string {
  const msg = (err as { message?: unknown })?.message;
  if (typeof msg === 'string') return msg.split('\n', 1)[0]!.slice(0, 200);
  return String(err);
}

// Transient = server mid crash-recovery or TCP not up yet. Walks the cause
// chain because Drizzle wraps the postgres.js error in a DrizzleQueryError, so
// the SQLSTATE lives on `err.cause`, not `err`.
function isTransientDbError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e != null && depth < 6; depth++) {
    const code = (e as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NET_CODES.has(code))
    ) {
      return true;
    }
    const msg = (e as { message?: unknown }).message;
    if (
      typeof msg === 'string' &&
      /the database system is (starting up|shutting down|in recovery)|ECONNREFUSED|ECONNRESET|Connection refused/i.test(
        msg,
      )
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export interface WaitForDatabaseOptions {
  /** Total budget before giving up and rethrowing the last error. Default 30000. */
  timeoutMs?: number;
  /** Called before each backoff sleep so the caller can log the wait. */
  onRetry?: (info: { attempt: number; waitedMs: number; reason: string }) => void;
}

/**
 * Block until the database answers `select 1`, retrying with capped exponential
 * backoff while the error is transient (server mid crash-recovery, TCP not up).
 * Non-transient errors (auth, bad DSN) rethrow immediately. Rethrows the last
 * transient error once `timeoutMs` is exhausted.
 *
 * Guards the boot-order race where api/worker connect before Postgres finishes
 * startup and hit `57P03: the database system is starting up`, which otherwise
 * kills bootstrap with no retry.
 */
export async function waitForDatabaseReady(
  db: Database,
  options: WaitForDatabaseOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await db.execute(sql`select 1`);
      return;
    } catch (err) {
      if (!isTransientDbError(err) || Date.now() >= deadline) throw err;
      const waitedMs = Math.min(2000, 250 * 2 ** Math.min(attempt - 1, 3));
      options.onRetry?.({ attempt, waitedMs, reason: shortReason(err) });
      await new Promise((resolve) => setTimeout(resolve, waitedMs));
    }
  }
}
