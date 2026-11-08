import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from './api-client';
import { API_BASE_URL } from './api-client';

afterEach(() => vi.unstubAllGlobals());

describe('retryModule request contract', () => {
  it('U11 posts to the encoded module URL with no body and resolves the parsed JSON', async () => {
    expect(typeof (client as Record<string, unknown>).retryModule).toBe('function');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ moduleId: 'a b/c' })));
    vi.stubGlobal('fetch', fetch);

    const result = await (
      client as unknown as { retryModule: (id: string) => Promise<unknown> }
    ).retryModule('a b/c');

    expect(result).toEqual({ moduleId: 'a b/c' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${API_BASE_URL}/modules/a%20b%2Fc/retry`);
    expect(init).toMatchObject({ method: 'POST' });
    expect(init.body).toBeUndefined();
  });
});
