import pino from 'pino';
import { boundQueryError, serializeError, safeErrorDetails, safeErrorMessage } from './errors.js';

export {
  boundQueryError,
  safeErrorDetails,
  safeErrorMessage,
  scrubErrorPaths,
  serializeError,
} from './errors.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  serializers: {
    err: serializeError,
    // Existing `error` fields use ordinary JSON serialization for non-DB errors.
    error: (err: unknown) => (boundQueryError(err) ? serializeError(err) : err),
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

/** Log while the error still has structure, before BullMQ reduces it to message/stack. */
export function safeErrorForTransport(err: unknown, job?: { name: string; id?: string }): unknown {
  if (!boundQueryError(err)) return err;
  logger.error({ err, name: job?.name, jobId: job?.id }, 'database job failed');
  const { code } = safeErrorDetails(err);
  return new Error(`${safeErrorMessage(err)}${code === undefined ? '' : ` (${code})`}`);
}
