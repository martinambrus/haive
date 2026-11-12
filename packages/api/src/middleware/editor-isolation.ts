import { logger } from '@haive/shared';
import type { MiddlewareHandler } from 'hono';
import { HttpError, type AppEnv } from '../context.js';
import { canonicalOrigin, editorOrigin, isIdePath } from '../lib/request-origin.js';

/** Browser script on the api-hosted editor must not read the app's session. A browser cannot
 *  forge Fetch Metadata; server callers have no header, and the web proxy strips its own. */
export function editorIsolation(webOrigin: string): MiddlewareHandler<AppEnv> {
  const editor = editorOrigin(webOrigin);
  const sharedOrigin = editor === canonicalOrigin(webOrigin);
  if (sharedOrigin) {
    logger.warn(
      { webOrigin, editorOrigin: editor },
      'The editor cannot be isolated without a separate editor hostname',
    );
  }
  return async (c, next) => {
    if (
      !sharedOrigin &&
      !isIdePath(c.req.path) &&
      c.req.header('sec-fetch-site') === 'same-origin'
    ) {
      throw new HttpError(403, 'Refused a request from the editor origin');
    }
    await next();
  };
}
