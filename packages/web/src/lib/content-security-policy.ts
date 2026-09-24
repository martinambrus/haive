/** Where a page may load images, media and fonts from: itself, inline data, object URLs and the api
 *  (screenshots). A body can name any URL, and this is what keeps the browser from fetching it. No
 *  `script-src` or `default-src`, so the root layout's inline script needs no nonce. */
export function contentSecurityPolicy(apiUrl: string): string {
  const api = apiSources(apiUrl);
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

/** The api's host under both schemes, without its path (a source with a path matches that path
 *  alone). A TLS proxy serves the page over https while the server sees http, and Chrome does not
 *  let an http source admit an https URL on an explicit port. */
function apiSources(url: string): string {
  try {
    const { protocol, host } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    return ` http://${host} https://${host}`;
  } catch {
    return '';
  }
}
