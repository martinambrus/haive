import { API_PROXY_PATH } from './api-origin';
import { resolveServerApiBase } from './api-base.server';

/** The upstream is operator configuration only. Neither Host nor a path supplied by a client
 * can select another server. Keep /ide intact for the editor's redirects and relative assets. */
export function apiProxyTarget(requestUrl: string): URL | null {
  const request = new URL(requestUrl);
  const path = request.pathname;
  const suffix = path.startsWith(`${API_PROXY_PATH}/`)
    ? path.slice(API_PROXY_PATH.length)
    : path.startsWith('/ide/')
      ? path
      : null;
  if (suffix === null) return null;
  const target = new URL(resolveServerApiBase());
  target.pathname = `${target.pathname.replace(/\/$/, '')}${suffix}`;
  target.search = request.search;
  return target;
}

function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const hopByHop = [
    'connection',
    'expect',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...(headers.get('connection') ?? '').split(',').map((name) => name.trim().toLowerCase()),
  ];
  for (const name of [...headers.keys()]) {
    if (hopByHop.includes(name)) headers.delete(name);
  }
  return headers;
}

/** Stream uploads and SSE without buffering; return every Set-Cookie separately. The API still
 * authenticates and checks the original browser Origin. No session rotation happens here. */
export async function proxyApiRequest(request: Request): Promise<Response> {
  let target: URL | null;
  try {
    target = apiProxyTarget(request.url);
  } catch {
    return new Response('Invalid server API URL configuration', { status: 502 });
  }
  if (!target) return new Response('Not found', { status: 404 });
  const headers = endToEndHeaders(request.headers);
  headers.delete('host');
  // These describe the browser's request to the web origin, not this server-to-api hop.
  // In proxy mode the app's own calls are same-origin at web; forwarding that value
  // would make the api mistake them for script running on its editor origin.
  for (const name of [...headers.keys()]) {
    if (name.startsWith('sec-fetch-')) headers.delete(name);
  }
  // Fetch decompresses responses. Asking for identity keeps the forwarded metadata accurate.
  headers.set('accept-encoding', 'identity');
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      duplex: 'half',
      redirect: 'manual',
      cache: 'no-store',
      signal: request.signal,
    } as RequestInit & { duplex: 'half' });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: endToEndHeaders(upstream.headers),
    });
  } catch {
    return new Response('API unavailable', { status: 502 });
  }
}
