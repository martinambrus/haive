import type { MiddlewareHandler } from 'hono';
import { HttpError, type AppEnv } from '../context.js';

/** A request body that is not JSON is the caller's error: c.req.json() answers it with 400.
 *  Wrapping the call keeps parsing lazy, so a route's own body limit still runs first. */
export const jsonBodyErrors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const parse = c.req.json.bind(c.req);
  c.req.json = (async () => {
    try {
      return await parse();
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new HttpError(400, 'The request body is not valid JSON', 'invalid_json');
      }
      throw err;
    }
  }) as typeof c.req.json;
  await next();
};
