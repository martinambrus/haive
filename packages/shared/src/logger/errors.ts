import pino from 'pino';

const sanitizedErrors = new WeakSet<object>();

/** Walk wrappers without trusting their messages, and stop on cycles. */
function* errorChain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<object>();
  while (err !== null && typeof err === 'object' && !seen.has(err)) {
    seen.add(err);
    yield err as Record<string, unknown>;
    err = (err as { cause?: unknown }).cause;
  }
}

/** Drivers decorate unbound connection failures too; only actual bound values need hiding. */
export function boundQueryError(err: unknown): Record<string, unknown> | undefined {
  for (const current of errorChain(err)) {
    if (
      (Array.isArray(current.params) && current.params.length > 0) ||
      (Array.isArray(current.parameters) && current.parameters.length > 0)
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
  if (err !== null && typeof err === 'object' && sanitizedErrors.has(err)) return err;
  const queryError = boundQueryError(err);
  if (!queryError) return pino.stdSerializers.err(err as Error);
  const { name, code } = safeErrorDetails(err);
  const sanitized = {
    type: name,
    ...(code === undefined ? {} : { code }),
    ...(typeof queryError.query === 'string' ? { query: queryError.query } : {}),
  };
  sanitizedErrors.add(sanitized);
  return sanitized;
}

/** Response text must not expose query text, bound values or driver diagnostics. */
export function safeErrorMessage(err: unknown): string {
  if (boundQueryError(err)) return 'Database operation failed';
  return err instanceof Error ? err.message : String(err);
}
