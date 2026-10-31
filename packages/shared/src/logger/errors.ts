import pino from 'pino';

const sanitizedErrors = new WeakSet<object>();

/** Walk wrappers without trusting their messages, and stop on cycles. */
function* errorChain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<object>();
  const pending: unknown[] = [err];
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const node = current as Record<string, unknown>;
    yield node;
    if (Array.isArray(node.errors)) {
      for (let i = node.errors.length - 1; i >= 0; i--) pending.push(node.errors[i]);
    }
    pending.push(node.cause);
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
  // A wrapper or another aggregate member can carry an unrelated filesystem code.
  // Attribute diagnostics to the same bound query we serialize and its driver cause.
  for (const { code } of errorChain(boundQueryError(err) ?? err)) {
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

/** Display copy for filesystem/git failures: retain the diagnosis and URLs, hide absolute
 *  POSIX, drive and UNC paths. Quoted paths may contain spaces; unquoted tokens end at
 *  whitespace or diagnostic punctuation. The placeholder contains no path, so repairs converge.
 *  Keep safeErrorMessage's ordinary-error contract unchanged for other diagnostic sinks. */
export function scrubErrorPaths(err: unknown): string {
  return safeErrorMessage(err).replace(
    /[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s"'`<>]+|(["'`])(?:[a-zA-Z]:[\\/]|\\\\|\/)[^\r\n]*?\1|(?<![\w./\\:-])(?:[a-zA-Z]:[\\/]|\\\\|\/)[^\s"'`<>:,;!?()[\]{}]*/g,
    (token: string, quote: string | undefined) => {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\//.test(token)) return token;
      return quote ? `${quote}[path]${quote}` : '[path]';
    },
  );
}
