import type { MiddlewareHandler } from 'hono';
import { HttpError, type AppEnv } from '../context.js';

/** A request body that is not a form is the caller's error: c.req.formData() rejects with a
 *  TypeError, the Fetch standard's class, for a content type other than multipart/form-data and
 *  application/x-www-form-urlencoded and for a body that does not parse as one, and unmapped that
 *  is a 500. Matched on the class, never on the runtime's message. Wrapping the call keeps parsing
 *  lazy, so a route's own body limit still runs first. */
export const formBodyErrors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const parse = c.req.formData.bind(c.req);
  c.req.formData = (async () => {
    try {
      return await parse();
    } catch (err) {
      if (err instanceof TypeError) {
        throw new HttpError(400, 'The request body is not a valid form', 'invalid_form');
      }
      throw err;
    }
  }) as typeof c.req.formData;
  await next();
};
