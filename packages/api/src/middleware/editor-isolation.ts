import { logger } from '@haive/shared';
import type { MiddlewareHandler } from 'hono';
import { HttpError, type AppEnv } from '../context.js';
import {
  canonicalOrigin,
  editorOrigin,
  isIdePath,
  publicApiOrigin,
} from '../lib/request-origin.js';

/** Browser script on the api-hosted editor must not read the app's session. A browser cannot
 *  forge Fetch Metadata; server callers have no header, and the web proxy strips its own. */
export function editorIsolation(webOrigin: string): MiddlewareHandler<AppEnv> {
  const web = canonicalOrigin(webOrigin);
  const editor = editorOrigin(webOrigin);
  // A same-origin request to the api comes from a page the api's origin serves. When the app
  // itself is served there (one-origin install), that page may be the app, so the header cannot
  // single out the editor: with an editor hostname of its own, the editor's requests are
  // cross-origin and the Origin checks refuse them instead.
  const appOnApi = publicApiOrigin(webOrigin) === web;
  if (editor === web) {
    logger.warn(
      { webOrigin, editorOrigin: editor },
      'The editor cannot be isolated without a separate editor hostname',
    );
  }
  return async (c, next) => {
    if (!appOnApi && !isIdePath(c.req.path) && c.req.header('sec-fetch-site') === 'same-origin') {
      throw new HttpError(403, 'Refused a request from the editor origin');
    }
    await next();
  };
}
