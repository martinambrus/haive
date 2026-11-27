import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GLOBAL_KB_EMBED_PROBE_TIMEOUT_MS,
  OllamaProbeTimeoutError,
  probeGlobalKbEmbedding,
} from '../src/lib/global-kb-embed-probe.js';

// Node's native AbortSignal.timeout is not advanced by Vitest's fake clock.
// The probe's own timer is the deadline under test; keep the shared helper's
// backstop inert so a loaded host cannot expire it between fake-clock turns.
beforeEach(() => {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('pins the production interactive budget', () => {
  expect(GLOBAL_KB_EMBED_PROBE_TIMEOUT_MS).toBe(8_000);
});

it.each(['headers', 'body'])(
  'bounds a never-answering %s with an injected deadline and aborts transport',
  async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      if (phase === 'headers') return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const outcome = probeGlobalKbEmbedding('http://embed.example', 'embed', {
      fetchFn,
      timeoutMs: 17,
    });
    const caught = outcome.catch((error: unknown) => error);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(17);
    await vi.advanceTimersByTimeAsync(16);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await caught).toBeInstanceOf(OllamaProbeTimeoutError);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('clears its deadline after a successful embed', async () => {
  vi.useFakeTimers();
  const fetchFn = vi.fn(async () =>
    Response.json({ embeddings: [[1, 2]] }),
  ) as unknown as typeof fetch;
  expect(
    await probeGlobalKbEmbedding('http://embed.example', 'embed', { fetchFn, timeoutMs: 17 }),
  ).toEqual([[1, 2]]);
  expect(vi.getTimerCount()).toBe(0);
});

it('honours request cancellation even if the transport never settles', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetchFn = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const reason = new Error('request cancelled');
  const outcome = probeGlobalKbEmbedding('http://embed.example', 'embed', {
    fetchFn,
    timeoutMs: 17,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  controller.abort(reason);
  expect(await outcome).toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
});

it('refuses a request cancelled before entry without starting transport', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const reason = new Error('already cancelled');
  controller.abort(reason);
  const fetchFn = vi.fn() as unknown as typeof fetch;
  expect(
    await probeGlobalKbEmbedding('http://embed.example', 'embed', {
      fetchFn,
      timeoutMs: 17,
      signal: controller.signal,
    }).catch((error: unknown) => error),
  ).toBe(reason);
  expect(fetchFn).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
