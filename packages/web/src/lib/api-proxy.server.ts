import { API_PROXY_PATH, FALLBACK_API_URL } from './api-origin';

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
  const target = new URL(
    process.env.API_URL_INTERNAL ??
      process.env.HAIVE_PUBLIC_API_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      FALLBACK_API_URL,
  );
  target.pathname = `${target.pathname.replace(/\/$/, '')}${suffix}`;
  target.search = request.search;
  return target;
}

function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const hopByHop = [
    'connection',
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
  const target = apiProxyTarget(request.url);
  if (!target) return new Response('Not found', { status: 404 });
  const headers = endToEndHeaders(request.headers);
  headers.delete('host');
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
