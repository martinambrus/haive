import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { isUniqueViolationOf, ONE_LIVE_UPGRADE_INDEX } from '@haive/database';
import { logger } from '@haive/shared';
import { HttpError, type AppEnv } from '../context.js';

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { error: err.message, code: err.code ?? null },
      err.status as 400 | 401 | 403 | 404 | 409 | 500,
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: 'Validation failed',
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      400,
    );
  }
  // Every route that revives a failed task reaches this index, so it answers here once.
  if (isUniqueViolationOf(err, ONE_LIVE_UPGRADE_INDEX)) {
    return c.json(
      { error: 'An upgrade or rollback is already in progress for this repository', code: null },
      409,
    );
  }
  logger.error({ err }, 'Unhandled API error');
  return c.json({ error: 'Internal server error' }, 500);
};
