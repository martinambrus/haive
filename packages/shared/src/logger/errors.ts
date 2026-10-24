import { DrizzleQueryError } from 'drizzle-orm/errors';
import pino from 'pino';

/** Walk wrappers without trusting their messages, and stop on cycles. */
function* errorChain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<object>();
  while (err !== null && typeof err === 'object' && !seen.has(err)) {
    seen.add(err);
    yield err as Record<string, unknown>;
    err = (err as { cause?: unknown }).cause;
  }
}

/** A driver can attach query/params non-enumerably; wrappers can hide them in cause. */
export function boundQueryError(err: unknown): Record<string, unknown> | undefined {
  for (const current of errorChain(err)) {
    if (
      current instanceof DrizzleQueryError ||
      (current instanceof Error && current.constructor.name === 'DrizzleQueryError') ||
      Object.hasOwn(current, 'query') ||
      Object.hasOwn(current, 'params')
    ) {
      return current;
    }
  }
  return undefined;
}

/** Keep diagnostics without serializing query messages, bound params or stacks. */
export function safeErrorDetails(err: unknown): { name: string; code?: string | number } {
  const name = err instanceof Error ? err.constructor.name : 'UnknownError';
  for (const { code } of errorChain(err)) {
    if (typeof code === 'string' || typeof code === 'number') return { name, code };
  }
  return { name };
}

/** Allow-list DB diagnostics: even the driver's detail/stack can quote a failing row. */
export function serializeError(err: unknown): unknown {
  const queryError = boundQueryError(err);
  if (!queryError) return pino.stdSerializers.err(err as Error);
  const { name, code } = safeErrorDetails(err);
  return {
    type: name,
    ...(code === undefined ? {} : { code }),
    ...(typeof queryError.query === 'string' ? { query: queryError.query } : {}),
  };
}

/** Response text must not expose query text, bound values or driver diagnostics. */
export function safeErrorMessage(err: unknown): string {
  if (boundQueryError(err)) return 'Database operation failed';
  return err instanceof Error ? err.message : String(err);
}

/** BullMQ keeps only message/stack on failure, so sanitize BEFORE it loses the class. */
export function safeErrorForTransport(err: unknown): unknown {
  return boundQueryError(err) ? new Error(safeErrorMessage(err)) : err;
}
