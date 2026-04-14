import type { MiddlewareHandler } from 'hono';
import { logger } from '@haive/shared';
import type { AppEnv } from '../context.js';

export const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: duration,
    },
    'request',
  );
};
