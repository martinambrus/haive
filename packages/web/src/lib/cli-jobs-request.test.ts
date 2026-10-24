import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPricingRefresh } from './cli-jobs';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cli-jobs request cancellation', () => {
  it.each(['POST', 'GET'])('aborts the in-flight %s through the API client', async (method) => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (method === 'GET' && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ jobId: '42' })));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = runPricingRefresh(undefined, controller.signal).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const request = fetchMock.mock.calls.at(-1)?.[1];
    try {
      expect(request?.signal).toBe(controller.signal);
    } finally {
      controller.abort();
    }
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(method === 'POST' ? 1 : 2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
