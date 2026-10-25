import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverBrowserSession } from './browser-session';

const API = 'http://api.test';
function coordinated() {
  let tail = Promise.resolve<unknown>(undefined);
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
        const next = tail.then(callback);
        tail = next.catch(() => {});
        return next;
      },
    },
  });
}
const response = (status: number) => new Response('{}', { status });
afterEach(() => vi.unstubAllGlobals());

describe('browser refresh coordination', () => {
  it('waits through a late winning response, then rechecks before a second tab rotates', async () => {
    coordinated();
    let installed = false;
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (arrived = resolve));
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/me')) return response(installed ? 200 : 401);
      arrived();
      await gate;
      installed = true;
      return response(200);
    });
    vi.stubGlobal('fetch', fetcher);
    const first = recoverBrowserSession(API);
    await ready;
    const second = recoverBrowserSession(API);
    await Promise.resolve();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/refresh'))).toHaveLength(1);
    release();
    expect(await first).toBe('authenticated');
    expect(await second).toBe('authenticated');
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/refresh'))).toHaveLength(1);
  });

  it.each([500, 503])('does not rotate or revoke after an initial /me %s', async (status) => {
    coordinated();
    const fetcher = vi.fn().mockResolvedValue(response(status));
    vi.stubGlobal('fetch', fetcher);
    expect(await recoverBrowserSession(API)).toBe('unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not interpret network errors as revocation', async () => {
    coordinated();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await recoverBrowserSession(API)).toBe('unavailable');
  });

  it('uses the current jar after refresh was refused', async () => {
    coordinated();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response(401))
        .mockResolvedValueOnce(response(401))
        .mockResolvedValueOnce(response(200)),
    );
    expect(await recoverBrowserSession(API)).toBe('authenticated');
  });

  it('reports rejection only after both tokens are refused under the lock', async () => {
    coordinated();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401)));
    expect(await recoverBrowserSession(API)).toBe('rejected');
  });

  it('keeps recovery available without Web Locks when a winner could still be in flight', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401)));
    expect(await recoverBrowserSession(API)).toBe('unavailable');
  });
});
