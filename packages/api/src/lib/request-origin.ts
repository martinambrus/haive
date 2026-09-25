export function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://localhost:3000';
}

/** The origin the browser calls the api on, resolved as `web/src/lib/api-origin.ts` resolves it. A
 *  reverse proxy may rewrite `Host`, so the request alone cannot say what that origin is. */
export function publicApiOrigin(web: string = webOrigin()): string | null {
  try {
    const configured = process.env.HAIVE_PUBLIC_API_URL;
    if (configured) return new URL(configured).origin;
    const port = process.env.HAIVE_API_PORT;
    if (!port) return null;
    const page = new URL(web);
    return new URL(`${page.protocol}//${page.hostname}:${port}`).origin;
  } catch {
    return null;
  }
}

/** The app's own origin, and the api's, where the editor it proxies runs. */
export function trustedOrigins(web: string = webOrigin()): string[] {
  const api = publicApiOrigin(web);
  return api === null ? [web] : [web, api];
}

/** A page on the same site still sends the SameSite=Lax cookie, so only `Origin` tells it from the
 *  app's own pages. The request's own host passes too, for an api reached directly. */
export function isForeignOrigin(
  origin: string | undefined,
  host: string | undefined,
  trusted: readonly string[],
): boolean {
  if (origin === undefined || trusted.includes(origin)) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
