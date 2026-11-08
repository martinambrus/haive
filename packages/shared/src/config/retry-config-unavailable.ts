import { logger } from '../logger/index.js';
import { ConfigUnavailableError } from './config-unavailable.js';

/**
 * Runs a boot step again for as long as the configuration store is unavailable. Infinite on
 * purpose: an exit is a dead watcher under `tsx watch` in dev and a crash loop in production, while
 * waiting keeps the process up until the store answers. Only the typed outage is retried; a server
 * error reply, a missing env var, a database error or a key mismatch will not fix itself, so they
 * are rethrown at once and the caller still exits.
 */
export async function retryWhileConfigUnavailable<T>(
  what: string,
  run: () => Promise<T>,
  options: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof ConfigUnavailableError)) throw err;
      const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      logger.warn(
        { what, attempt, waitedMs: Date.now() - startedAt, delayMs, err },
        'configuration store unavailable, retrying',
      );
      await sleep(delayMs);
    }
  }
}
