import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared/logger';
import { apiProxyTarget, proxyApiRequest } from './api-proxy.server';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('web-origin API forwarding', () => {
  it('drops Expect and forbidden hop headers before a real undici fetch', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => res.end('accepted'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    vi.stubEnv('API_URL_INTERNAL', 'http://127.0.0.1:' + address.port);
    try {
      const res = await proxyApiRequest(
        new Request('http://web.test/api/haive/upload', {
          method: 'POST',
          body: 'payload',
          headers: {
            expect: '100-continue',
            upgrade: 'websocket',
            connection: 'x-hop',
            'x-hop': 'drop',
            'transfer-encoding': 'chunked',
          },
        }),
      );
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe('accepted');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('strips every incoming Fetch Metadata header while preserving session and Origin', async () => {
    vi.stubEnv('API_URL_INTERNAL', 'http://api:3001');
    const fetcher = vi.fn().mockResolvedValue(new Response('accepted'));
    vi.stubGlobal('fetch', fetcher);
    const res = await proxyApiRequest(
      new Request('https://web.test/api/haive/auth/me', {
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
          'sec-fetch-user': '?1',
          'sec-fetch-future': 'future',
          cookie: 'haive_access=session',
          origin: 'https://web.test',
        },
      }),
    );
    expect(res.status).toBe(200);
    const headers = fetcher.mock.calls[0]![1].headers as Headers;
    expect([...headers.keys()].filter((name) => name.startsWith('sec-fetch-'))).toEqual([]);
    expect(headers.get('cookie')).toBe('haive_access=session');
    expect(headers.get('origin')).toBe('https://web.test');
  });

  it('reports invalid upstream configuration once and returns 502 on repeated requests', async () => {
    vi.stubEnv('API_URL_INTERNAL', 'missing-scheme.invalid');
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (let i = 0; i < 2; i++) {
      const res = await proxyApiRequest(new Request('http://web.test/api/haive/auth/login'));
      expect(res.status).toBe(502);
      expect(await res.text()).toMatch(/invalid.*API.*URL/i);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it('uses only the configured upstream, retaining path, query and editor namespace', () => {
    vi.stubEnv('API_URL_INTERNAL', 'http://api:3001/base/');
    expect(apiProxyTarget('https://web.test/api/haive//evil.test/asset.js?q=%2F')?.href).toBe(
      'http://api:3001/base//evil.test/asset.js?q=%2F',
    );
    expect(apiProxyTarget('https://web.test/ide/repos/id/asset.js')?.href).toBe(
      'http://api:3001/base/ide/repos/id/asset.js',
    );
    expect(apiProxyTarget('https://web.test/api/app-build')).toBeNull();
    expect(apiProxyTarget('https://web.test/api/haive-other/auth/login')).toBeNull();
  });

  it('streams the body with original cookies and foreign Origin; returns both host-only cookies', async () => {
    vi.stubEnv('API_URL_INTERNAL', 'http://api:3001');
    const headers = new Headers();
    headers.append('set-cookie', 'haive_access=a; Path=/; HttpOnly; SameSite=Lax');
    headers.append('set-cookie', 'haive_refresh=r; Path=/; HttpOnly; SameSite=Lax');
    headers.set('connection', 'x-hop');
    headers.set('x-hop', 'drop');
    const upstream = new Response('{"ok":true}', { headers });
    const fetcher = vi.fn().mockResolvedValue(upstream);
    vi.stubGlobal('fetch', fetcher);
    const request = new Request('https://web.test/api/haive/auth/login', {
      method: 'POST',
      body: '{"password":"synthetic"}',
      headers: {
        cookie: 'haive_access=old',
        origin: 'https://foreign.test',
        host: 'web.test',
        connection: 'x-hop',
        'x-hop': 'drop',
        'content-type': 'application/json',
      },
    });
    const result = await proxyApiRequest(request);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://api:3001/auth/login');
    expect(init.body).toBe(request.body);
    expect(init.headers.get('cookie')).toBe('haive_access=old');
    expect(init.headers.get('origin')).toBe('https://foreign.test');
    expect(init.headers.get('host')).toBeNull();
    expect(init.headers.get('x-hop')).toBeNull();
    expect(init).toMatchObject({ redirect: 'manual', cache: 'no-store', signal: request.signal });
    expect(result.headers.getSetCookie()).toEqual(headers.getSetCookie());
    expect(result.headers.get('x-hop')).toBeNull();
    expect(await result.json()).toEqual({ ok: true });
  });

  it('returns an SSE stream before the upstream closes and cancels it on browser cancellation', async () => {
    vi.stubEnv('API_URL_INTERNAL', 'http://api:3001');
    const cancel = vi.fn();
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        writer = controller;
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    const result = await proxyApiRequest(new Request('https://web.test/api/haive/events'));
    expect(result.headers.get('content-type')).toBe('text/event-stream');
    writer.enqueue(new TextEncoder().encode('data: first\n\n'));
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    await reader.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves refusal and redirect statuses without following or rotating', async () => {
    vi.stubEnv('API_URL_INTERNAL', 'http://api:3001');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('foreign', { status: 403 })));
    expect(
      (await proxyApiRequest(new Request('https://web.test/api/haive/auth/logout'))).status,
    ).toBe(403);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: '/ide/id/login' },
        }),
      ),
    );
    const redirect = await proxyApiRequest(new Request('https://web.test/ide/id/'));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/ide/id/login');
    expect(redirect.headers.getSetCookie()).toEqual([]);
  });
});
