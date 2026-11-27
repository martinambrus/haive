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
// Lower the shared injectable seam; exercise the real deadline and embed transport.
vi.mock('../src/lib/global-kb-embed-probe.js', async (original) => {
  const actual = await original<typeof import('../src/lib/global-kb-embed-probe.js')>();
  return {
    ...actual,
    probeGlobalKbEmbedding: (
      url: string,
      model: string,
      opts: Parameters<typeof actual.probeGlobalKbEmbedding>[2],
    ) => actual.probeGlobalKbEmbedding(url, model, { ...opts, timeoutMs: 17 }),
  };
});
import { toolingRoutes } from '../src/routes/tooling.js';
const app = new Hono().route('/tooling', toolingRoutes);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.fetchFn.mockReset();
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
    await vi.advanceTimersByTimeAsync(16);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toMatchObject({
      ok: false,
      reachable: true,
      code: 'ollama_probe_timeout',
      retryable: true,
    });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  },
);
