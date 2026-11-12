export function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://localhost:3000';
}

/** The origin the browser calls the api on, resolved as `web/src/lib/api-origin.ts` resolves it. A
 *  reverse proxy may rewrite `Host`, so the request alone cannot say what that origin is. */
export function publicApiOrigin(web: string = webOrigin()): string | null {
  try {
    // A blank or whitespace value is unset, as the web app reads it.
    const configured = process.env.HAIVE_PUBLIC_API_URL?.trim();
    if (configured) return new URL(configured).origin;
    const port = process.env.HAIVE_API_PORT?.trim();
    if (!port) return null;
    const page = new URL(web);
    return new URL(`${page.protocol}//${page.hostname}:${port}`).origin;
  } catch {
    return null;
  }
}

/** The serialised origin a browser sends in `Origin` (lower case, no default port, no path), so
 *  an operator's spelling of WEB_ORIGIN cannot defeat an exact comparison. */
export function canonicalOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

/** An optional dedicated editor origin, otherwise the api's public origin. */
export function editorOrigin(web: string = webOrigin()): string | null {
  const configured = process.env.HAIVE_EDITOR_ORIGIN?.trim();
  if (!configured) return publicApiOrigin(web);
  try {
    const url = new URL(configured);
    // Check the raw suffix too: URL normalisation hides /./ and empty ?/#.
    if (
      !/^https?:\/\/[^/\\?#\s]+\/?$/i.test(configured) ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      configured.includes('@') ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid origin');
    return url.origin;
  } catch {
    throw new Error(
      'HAIVE_EDITOR_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment',
    );
  }
}

export function isIdePath(path: string): boolean {
  return path === '/ide' || path.startsWith('/ide/');
}

/** Only the editor's own requests may trust its origin. App routes trust the web origin. */
export function trustedOrigins(web: string = webOrigin(), path = '/'): string[] {
  const app = canonicalOrigin(web);
  const editor = editorOrigin(web);
  return isIdePath(path) && editor !== null ? [app, editor] : [app];
}

/** A page on the same site still sends the SameSite=Lax cookie, so only `Origin` tells it from the
 *  app's own pages. The api serves no app page: its own host is trusted only under /ide. */
export function isForeignOrigin(
  origin: string | undefined,
  host: string | undefined,
  trusted: readonly string[],
  path = '/',
): boolean {
  if (origin === undefined || trusted.includes(origin)) return false;
  if (!isIdePath(path)) return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
