import { afterEach, expect, it, vi } from 'vitest';
import * as client from './api-client';

afterEach(() => vi.unstubAllGlobals());
it('delivers plan deltas once with keepalive, even when the API refuses', async () => {
  const fetch = vi.fn().mockResolvedValue({ status: 401, ok: false });
  vi.stubGlobal('fetch', fetch);
  client.postPlanUserActive('repo-id', 1234);
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining('/repositories/repo-id/plan/user-active'),
    {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deltaMs: 1234 }),
    },
  );
});
it('swallows delivery rejection without a retry and ignores empty deltas', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetch);
  client.postPlanUserActive('repo-id', 0);
  expect(fetch).not.toHaveBeenCalled();
  client.postPlanUserActive('repo-id', 1000);
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(1);
});
