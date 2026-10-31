import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, discardPlanMerge } from './api-client';

afterEach(() => vi.unstubAllGlobals());

describe('discardPlanMerge request contract', () => {
  it.each([
    [undefined, '/repositories/repo-1/plan/merge'],
    [
      '00000000-0000-4000-8000-000000000491',
      '/repositories/repo-1/plan/merge?taskId=00000000-0000-4000-8000-000000000491',
    ],
    ['', '/repositories/repo-1/plan/merge?taskId='],
    ['a /?&=b', '/repositories/repo-1/plan/merge?taskId=a%20%2F%3F%26%3Db'],
  ])('uses the exact DELETE URL for taskId %j', async (taskId, path) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, cancelled: false })));
    vi.stubGlobal('fetch', fetch);

    expect(await discardPlanMerge('repo-1', taskId)).toEqual({ ok: true, cancelled: false });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${API_BASE_URL}${path}`);
    expect(init).toMatchObject({ method: 'DELETE' });
  });
});
