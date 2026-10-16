import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { hasPgCode, isUniqueViolationOf, ONE_LIVE_UPGRADE_INDEX } from '@haive/database';
import { logger } from '@haive/shared';
import { HttpError, type AppEnv } from '../context.js';

const INVALID_TEXT_REPRESENTATION = '22P02';
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { error: err.message, code: err.code ?? null },
      err.status as ContentfulStatusCode,
    );
  }
  if (err instanceof HTTPException) {
    // A thrown response keeps its own body and headers (WWW-Authenticate, Retry-After).
    if (err.res) {
      return c.newResponse(err.res.body, { status: err.status, headers: err.res.headers });
    }
    return c.json({ error: err.message, code: null }, err.status);
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
  // 22P02 from a path id that is not a uuid is an unknown id, not a server fault.
  if (
    hasPgCode(err, INVALID_TEXT_REPRESENTATION) &&
    Object.values(c.req.param()).some((value) => !UUID_TEXT.test(value))
  ) {
    return c.json({ error: 'Not found', code: null }, 404);
  }
  logger.error({ err }, 'Unhandled API error');
  return c.json({ error: 'Internal server error' }, 500);
};
