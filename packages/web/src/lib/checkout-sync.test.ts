import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlanOverview, requestCheckoutSync } from './api-client';

afterEach(() => vi.unstubAllGlobals());
describe('checkout hints from the plan overview', () => {
  it('sends a POST to the mounted repo route and preserves the overview GET', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(input, 'http://localhost').pathname}`);
      return { ok: true, status: 200, json: async () => ({ nodeCount: 0 }) };
    });
    expect(await getPlanOverview('repo-1')).toMatchObject({ nodeCount: 0 });
    expect(calls).toEqual(
      expect.arrayContaining(['POST /repos/repo-1/sync-checkout', 'GET /repositories/repo-1/plan']),
    );
  });
  it('keeps a failed hint from blocking the read', async () => {
    vi.stubGlobal('fetch', async (_input: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('offline hint');
      return { ok: true, status: 200, json: async () => ({ nodeCount: 2 }) };
    });
    await expect(requestCheckoutSync('repo-1')).resolves.toBeUndefined();
    expect(await getPlanOverview('repo-1')).toMatchObject({ nodeCount: 2 });
  });
});
