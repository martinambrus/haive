import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('all browser session cookie writers', () => {
  it.each([
    ['POST', '/auth/login'],
    ['POST', '/auth/register'],
    ['POST', '/auth/logout'],
    ['PUT', '/user-settings/password'],
  ])('constructs %s %s inside the shared lock', async (method, path) => {
    vi.resetModules();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inside = false;
    const lock = vi.fn(
      async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
        await gate;
        inside = true;
        try {
          return await callback();
        } finally {
          inside = false;
        }
      },
    );
    vi.stubGlobal('navigator', { locks: { request: lock } });
    const insideAtFetch: boolean[] = [];
    const fetcher = vi.fn(async () => {
      insideAtFetch.push(inside);
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('../src/lib/api-client');
    const result =
      method === 'PUT'
        ? api.put(path, { sample: 'unchanged' })
        : api.post(path, { sample: 'unchanged' });
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    release();
    await result;
    expect(lock).toHaveBeenCalledTimes(1);
    expect(insideAtFetch).toEqual([true]);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(path),
      expect.objectContaining({ method, body: '{"sample":"unchanged"}' }),
    );
  });
});

describe('a password write whose access token expired', () => {
  it('releases the writer lock before refresh and reacquires it for retry', async () => {
    vi.resetModules();
    let inside = false;
    const lock = vi.fn(
      async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
        expect(inside, 'the writer lock cannot be entered recursively').toBe(false);
        inside = true;
        try {
          return await callback();
        } finally {
          inside = false;
        }
      },
    );
    vi.stubGlobal('navigator', { locks: { request: lock } });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(inside).toBe(true);
        calls.push(url);
        return new Response('{}', { status: calls.length === 1 ? 401 : 200 });
      }),
    );
    const { api } = await import('../src/lib/api-client');
    await api.put('/user-settings/password', {
      currentPassword: 'synthetic',
      newPassword: 'replacement',
    });
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      '/user-settings/password',
      '/auth/refresh',
      '/user-settings/password',
    ]);
    expect(lock).toHaveBeenCalledTimes(3);
  });
});
