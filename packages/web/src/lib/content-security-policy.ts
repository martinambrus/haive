/** Where a page may load images, media and fonts from: itself, inline data, object URLs and the api
 *  (screenshots). A body can name any URL, and this is what keeps the browser from fetching it. No
 *  `script-src` or `default-src`, so the root layout's inline script needs no nonce. */
export function contentSecurityPolicy(apiUrl: string): string {
  const api = originOf(apiUrl);
  return [
    `img-src 'self' data: blob:${api}`,
    `media-src 'self' blob:${api}`,
    "font-src 'self' data:",
  ].join('; ');
}

/** The hostname in the request's Host header, which is what the browser resolves the api against.
 *  Next's `nextUrl` does not carry it: a request sent with `Host: haive.example.test` read as localhost. */
export function browserHostname(hostHeader: string | null, fallback: string): string {
  if (!hostHeader) return fallback;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return fallback;
  }
}

/** The origin alone: a CSP source with a path matches that exact path, not the api's routes. */
function originOf(url: string): string {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? '' : ` ${origin}`;
  } catch {
    return '';
  }
}
