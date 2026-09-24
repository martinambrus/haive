export function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://localhost:3000';
}

/** A page on the same site still sends the SameSite=Lax cookie, so only `Origin` tells it from the
 *  app's own pages. The api's own origin is allowed too: the editor it proxies runs there. */
export function isForeignOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowed: string,
): boolean {
  if (origin === undefined || origin === allowed) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
