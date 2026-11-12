import pino from 'pino';
import { boundQueryError, serializeError, safeErrorDetails, safeErrorMessage } from './errors.js';

export {
  boundQueryError,
  safeErrorDetails,
  safeErrorMessage,
  scrubErrorPaths,
  serializeError,
} from './errors.js';

// A grant is a bearer secret and an editor cookie must never become log data.
// Walk structured bodies/headers at any depth, including batches, without changing callers.
function redactCredentials(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
  const prior = seen.get(value);
  if (prior) return prior;
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [name, field] of Object.entries(value)) {
    const lower = name.toLowerCase();
    const hidden =
      lower === 'secret' ||
      lower === 'cookie' ||
      lower === 'cookies' ||
      lower === 'set-cookie' ||
      lower.startsWith('haive_editor_');
    Object.defineProperty(copy, name, {
      value: hidden ? '[Redacted]' : redactCredentials(field, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function redactError(err: unknown): unknown {
  const serialized = serializeError(err);
  return redactCredentials(
    serialized && typeof serialized === 'object' ? { ...serialized } : serialized,
  );
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    log: (object) => redactCredentials(object) as Record<string, unknown>,
  },
  serializers: {
    err: redactError,
    // Existing `error` fields use ordinary JSON serialization for non-DB errors.
    error: (err: unknown) => (boundQueryError(err) ? redactError(err) : err),
  },
  hooks: {
    logMethod(args, method) {
      // Pino copies err.message into msg BEFORE running serializers. Replace only
      // bound-query errors here so bare error calls and { err } cannot bypass it.
      const [first, ...rest] = args;
      if (first instanceof Error && boundQueryError(first)) {
        return method.apply(this, [{ err: serializeError(first) }, ...rest] as typeof args);
      }
      if (first && typeof first === 'object' && 'err' in first && boundQueryError(first.err)) {
        return method.apply(this, [
          { ...first, err: serializeError(first.err) },
          ...rest,
        ] as typeof args);
      }
      return method.apply(this, args);
    },
  },
});

// Pino deliberately resets its bindings formatter on children. Sanitize bindings
// before child creation as well, including descendants that inherit this method.
const createChild = logger.child;
logger.child = function <ChildCustomLevels extends string = never>(
  this: pino.Logger,
  bindings: pino.Bindings,
  options?: pino.ChildLoggerOptions<ChildCustomLevels>,
): pino.Logger<ChildCustomLevels> {
  return Reflect.apply(createChild<ChildCustomLevels>, this, [
    redactCredentials(bindings) as pino.Bindings,
    options,
  ]);
};

/** Log while the error still has structure, before BullMQ reduces it to message/stack. */
export function safeErrorForTransport(err: unknown, job?: { name: string; id?: string }): unknown {
  if (!boundQueryError(err)) return err;
  logger.error({ err, name: job?.name, jobId: job?.id }, 'database job failed');
  const { code } = safeErrorDetails(err);
  return new Error(`${safeErrorMessage(err)}${code === undefined ? '' : ` (${code})`}`);
}
