import { logger } from '@haive/shared';
import { HttpError } from '../context.js';

/** How long a request waits for `Queue.add`. The api's BullMQ connection has
 *  `maxRetriesPerRequest: null` and an offline queue, so `add` waits out a Redis outage and a
 *  request awaiting it would hang. */
export const QUEUE_ADD_WAIT_MS = 2_000;

/** Awaits `add()` for at most `waitMs`; rejects on the add's own rejection or on the timeout.
 *  The add is not cancelled: after a timeout it can still land, so only queue work that is
 *  idempotent or guarded by the worker. A late rejection is swallowed. */
export async function boundedAdd<T>(
  add: () => Promise<T>,
  waitMs: number = QUEUE_ADD_WAIT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const pending = add();
    pending.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('redis did not answer in time')), waitMs);
    });
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Best effort: use when a committed row or a sweep already records the work, so a lost add
 *  never changes the HTTP outcome. Returns whether the add was accepted; never throws. */
export async function addBestEffort(
  add: () => Promise<unknown>,
  msg: string,
  fields?: Record<string, unknown>,
  waitMs?: number,
): Promise<boolean> {
  try {
    await boundedAdd(add, waitMs);
    return true;
  } catch (err) {
    logger.warn({ err, ...fields }, msg);
    return false;
  }
}

export class QueueUnavailableError extends HttpError {
  constructor() {
    super(503, 'Queue temporarily unavailable, try again shortly', 'queue_unavailable');
  }
}

/** Refuse: use when nothing else will ever queue the work and a repeat request is safe. Logs the
 *  cause and throws a 503 whose body does not carry it. */
export async function addOrRefuse<T>(
  add: () => Promise<T>,
  what: string,
  fields?: Record<string, unknown>,
  waitMs?: number,
): Promise<T> {
  try {
    return await boundedAdd(add, waitMs);
  } catch (err) {
    logger.warn({ err, ...fields }, `${what} not queued`);
    throw new QueueUnavailableError();
  }
}
