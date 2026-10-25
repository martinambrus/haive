import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(path: string, cookie = '') {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { host: 'browser.example.test:8443', cookie },
  });
}

describe('the actual Next proxy response', () => {
  it('redirects an anonymous private request without modifying cookies', async () => {
    const response = await proxy(request('/dashboard'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('sets the page CSP using the browser host and the runtime API port', async () => {
    vi.stubEnv('HAIVE_API_PORT', '46113');
    vi.stubEnv('HAIVE_PUBLIC_API_URL', '');
    const response = await proxy(request('/dashboard', 'haive_refresh=retained'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('content-security-policy')).toBe(
      "img-src 'self' data: blob: http://browser.example.test:46113 https://browser.example.test:46113; media-src 'self' blob: http://browser.example.test:46113 https://browser.example.test:46113; font-src 'self' data:",
    );
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('uses the explicit public API origin without admitting its path or unrelated hosts', async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://api.example.test:9443/prefix/');
    const response = await proxy(request('/login'));
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toContain('http://api.example.test:9443 https://api.example.test:9443');
    expect(policy).not.toMatch(/prefix|browser\.example|\*/);
  });

  it.each([401, 503])(
    'keeps public invitations usable after an auth probe returns %s',
    async (status) => {
      vi.stubEnv('API_URL_INTERNAL', 'http://fixture-api.invalid');
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal('fetch', fetch);
      const response = await proxy(
        request('/register?invite=kept', 'haive_access=stale; haive_refresh=kept'),
      );
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('content-security-policy')).toContain("img-src 'self'");
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]![0]).toBe('http://fixture-api.invalid/auth/me');
      expect(fetch.mock.calls[0]![1]).toMatchObject({
        headers: { Cookie: 'haive_access=stale; haive_refresh=kept' },
        cache: 'no-store',
      });
    },
  );

  it('redirects a verified public session and leaves expired-session login unprobed', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const response = await proxy(request('/login', 'haive_access=valid'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/dashboard');
    fetch.mockClear();
    const expired = await proxy(request('/login?session=expired', 'haive_access=stale'));
    expect(expired.headers.get('x-middleware-next')).toBe('1');
    expect(expired.headers.get('set-cookie')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
