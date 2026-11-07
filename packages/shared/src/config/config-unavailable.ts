/**
 * The configuration store (Redis) could not answer within its bound: it is down, reconnecting or
 * silent. It says nothing about whether a write was applied, so a caller must not assume either.
 * Callers that gate a decision on a value (fences, saves, revival) fail closed and let it
 * propagate; the api turns it into a 503. A server error reply is NOT this error, it stays the
 * ioredis `ReplyError`. Deliberately has no `code` property: `classifyGlobalKbError` walks `cause`
 * for one, and ours must not collide with it.
 */
export class ConfigUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, options?: { cause?: unknown }) {
    super(`Configuration store unavailable (${operation})`, options);
    this.name = 'ConfigUnavailableError';
    this.operation = operation;
  }
}

/** For a catch that swallows errors on purpose: lets a ConfigUnavailableError through so an outage
 *  is not mistaken for the thing the catch was written for. */
export function rethrowIfConfigUnavailable(err: unknown): void {
  if (err instanceof ConfigUnavailableError) throw err;
}
