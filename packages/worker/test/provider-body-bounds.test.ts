import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeOllamaEndpoint } from '../src/cli-adapters/ollama-probe.js';
import { probeOpenRouterModelCompat } from '../src/cli-adapters/openrouter-compat.js';
import { fetchZaiUsage } from '../src/usage-window/fetchers/zai.js';

function streamingResponse(status: number, json: string) {
  const bytes = new TextEncoder().encode(json);
  let pulled = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(pulled + 4096, bytes.length);
        controller.enqueue(bytes.subarray(pulled, end));
        pulled = end;
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(stream, { status }),
    readState: () => ({
      cancellations: cancel.mock.calls.length,
      wholeBodyRead: pulled === bytes.length,
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

const opts = { baseUrl: 'http://10.23.45.67', token: 'fixture-token', model: 'test-model' };

describe('bounded user endpoint bodies', () => {
  it('cuts off an oversized Ollama error and keeps only its HTTP status', async () => {
    const stream = streamingResponse(502, JSON.stringify({ error: 'x'.repeat(256 * 1024) }));
    const result = await probeOllamaEndpoint({ ...opts, fetchImpl: async () => stream.response });
    expect(stream.readState()).toEqual({ cancellations: 1, wholeBodyRead: false });
    expect(result).toEqual({ ok: false, detail: 'HTTP 502' });
  });

  it('cuts off an oversized OpenRouter 400 without condemning the model', async () => {
    const stream = streamingResponse(
      400,
      JSON.stringify({ error: { message: 'x'.repeat(256 * 1024) } }),
    );
    const result = await probeOpenRouterModelCompat({
      ...opts,
      fetchImpl: async () => stream.response,
    });
    expect(stream.readState()).toEqual({ cancellations: 1, wholeBodyRead: false });
    expect(result).toEqual({ compatible: true });
  });

  it('cuts off an oversized Z.AI reply without an auth or rate-limit outcome', async () => {
    const stream = streamingResponse(
      200,
      JSON.stringify({
        data: [{ type: 'TOKENS_LIMIT', percentage: 12 }],
        padding: 'x'.repeat(256 * 1024),
      }),
    );
    vi.stubGlobal('fetch', async () => stream.response);
    const result = await fetchZaiUsage('fixture-token', {
      providerName: 'zai',
      baseUrl: opts.baseUrl,
    });
    expect(stream.readState()).toEqual({ cancellations: 1, wholeBodyRead: false });
    expect(result).toMatchObject({ ok: false, rateLimited: false });
    expect(result).not.toHaveProperty('authExpired');
  });

  it('preserves an under-cap Z.AI reading', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ data: [{ type: 'TOKENS_LIMIT', percentage: 12 }] })),
    );
    expect(await fetchZaiUsage('fixture-token', { providerName: 'zai' })).toEqual({
      ok: true,
      windows: { fiveHour: { usedPct: 12, resetsAt: null } },
    });
  });
});
