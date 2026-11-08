import { HttpError } from '../context.js';

/** Redis did not answer a request-path command: down, or silent past the command deadline. */
export class RedisUnavailableError extends HttpError {
  constructor(cause: unknown) {
    super(503, 'Service temporarily unavailable', 'redis_unavailable');
    this.cause = cause;
  }
}
