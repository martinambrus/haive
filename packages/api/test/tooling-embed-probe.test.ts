import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetchFn: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', 'test-user');
    c.set('userRole', 'user');
    await next();
  },
}));
vi.mock('../src/lib/probe-hosts.js', () => ({
  probeEgressFor: async () => ({ fetchFn: h.fetchFn }),
}));
// Keep the real shared default: a route-specific timeout must not override it.
import { toolingRoutes } from '../src/routes/tooling.js';
const app = new Hono().route('/tooling', toolingRoutes);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.fetchFn.mockReset();
});
it('fix2 L3 uses the shared default for a 42.8-second cold embed without a route override', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
  h.fetchFn.mockImplementation(async (url: string) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'embed' }] });
    await new Promise<void>((resolve) => setTimeout(resolve, 42_800));
    return Response.json({ embeddings: [[1, 2]] });
  });
  const pending = app.request('/tooling/test-ollama', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ollamaUrl: 'http://embed.example', model: 'embed', dimensions: 2 }),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(AbortSignal.timeout).toHaveBeenLastCalledWith(60_000);
  await vi.advanceTimersByTimeAsync(42_800);
  expect(await (await pending).json()).toMatchObject({ ok: true, dims: 2, dimsMatch: true });
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['headers', 'body'])(
  'M4 bounds a never-answering embed %s and returns the coded retryable result',
  async (phase) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
    let signal: AbortSignal | undefined;
    h.fetchFn.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'embed' }] });
      signal = init?.signal ?? undefined;
      return phase === 'headers'
        ? new Promise<Response>(() => {})
        : new Response(new ReadableStream({ start() {} }));
    });
    let answer: unknown;
    const pending = Promise.resolve(
      app.request('/tooling/test-ollama', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ollamaUrl: 'http://embed.example', model: 'embed', dimensions: 2 }),
      }),
    ).then(async (res) => {
      answer = await res.json();
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(answer).toBeUndefined();
    expect(AbortSignal.timeout).toHaveBeenLastCalledWith(60_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({
      ok: true,
      reachable: true,
      modelCount: 1,
      modelFound: true,
      models: ['embed'],
      dims: null,
      dimsMatch: null,
      expectedDims: 2,
      dimsError: 'Embedding probe timed out; try again.',
      code: 'ollama_probe_timeout',
      retryable: true,
    });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  },
);
