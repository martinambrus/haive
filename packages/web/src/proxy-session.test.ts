import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('a delayed rejected-session navigation', () => {
  it('allows login without deleting cookies another request may have rotated', async () => {
    const response = await proxy(
      new NextRequest('http://localhost:46100/login?session=expired', {
        headers: { cookie: 'haive_access=new-access; haive_refresh=new-refresh' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('public pages with retained access cookies', () => {
  it.each(['/login', '/setup', '/register?invite=opaque-token'])(
    'does not bounce %s based on cookie presence',
    async (path) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
      const response = await proxy(
        new NextRequest(`http://localhost:46100${path}`, {
          headers: { cookie: 'haive_access=retained-invalid; haive_refresh=retained-invalid' },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
});

describe('validated public-page redirects', () => {
  it('keeps the dashboard redirect for a session the API accepts', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const response = await proxy(
      new NextRequest('http://localhost:46100/login', {
        headers: { cookie: 'haive_access=accepted; haive_refresh=accepted' },
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:46100/dashboard');
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/auth/me'),
      expect.objectContaining({
        headers: { Cookie: 'haive_access=accepted; haive_refresh=accepted' },
        cache: 'no-store',
      }),
    );
  });

  it('allows public navigation without deleting cookies during an auth outage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const response = await proxy(
      new NextRequest('http://localhost:46100/setup', {
        headers: { cookie: 'haive_access=uncertain' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
