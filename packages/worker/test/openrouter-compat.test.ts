import { describe, expect, it } from 'vitest';
import {
  extractOpenRouterErrorDetail,
  probeOpenRouterModelCompat,
} from '../src/cli-adapters/openrouter-compat.js';

// The exact body OpenRouter returned for qwen/qwen3.8-27b. Note the double-wrapped
// JSON-in-a-string from Chutes, the single-wrapped variant from AkashML in
// previous_errors, and that ALL THREE upstream providers failed the same way — which
// is what makes this a property of the model rather than of provider routing.
const REAL_400_BODY = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'Provider returned error',
    error_type: 'invalid_request',
  },
  metadata: {
    raw: '{"detail":"Invalid request: Invalid request: {\\"detail\\":{\\"object\\":\\"error\\",\\"message\\":\\"System message must be at the beginning.\\",\\"type\\":\\"BadRequest\\",\\"param\\":null,\\"code\\":400}}"}',
    provider_name: 'Chutes',
    previous_errors: [
      {
        code: 400,
        message: 'Provider returned error',
        provider_name: 'AkashML',
        raw: '{"error":{"message":"System message must be at the beginning.","type":"BadRequestError","param":null,"code":400}}',
      },
    ],
  },
};

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('extractOpenRouterErrorDetail', () => {
  it('digs the upstream sentence out of the real nested body', () => {
    expect(extractOpenRouterErrorDetail(REAL_400_BODY)).toBe(
      'System message must be at the beginning.',
    );
  });

  it('prefers the specific inner sentence over the generic outer wrapper', () => {
    // The outer layer only ever says "Provider returned error"; that is precisely
    // the message that made this failure undiagnosable from the UI.
    expect(extractOpenRouterErrorDetail(REAL_400_BODY)).not.toBe('Provider returned error');
  });

  it('handles a single-wrapped body', () => {
    expect(
      extractOpenRouterErrorDetail({
        error: { message: '{"error":{"message":"Model not supported here."}}' },
      }),
    ).toBe('Model not supported here.');
  });

  it('returns null rather than throwing on junk', () => {
    expect(extractOpenRouterErrorDetail(null)).toBeNull();
    expect(extractOpenRouterErrorDetail('plain string')).toBeNull();
    expect(extractOpenRouterErrorDetail({ nothing: 'useful' })).toBeNull();
    expect(extractOpenRouterErrorDetail({ error: { message: '   ' } })).toBeNull();
  });

  it('does not hang on a self-referencing object', () => {
    const cyclic: Record<string, unknown> = { message: 'boom' };
    cyclic.self = cyclic;
    expect(extractOpenRouterErrorDetail(cyclic)).toBe('boom');
  });
});

describe('probeOpenRouterModelCompat', () => {
  const base = { baseUrl: 'https://openrouter.ai/api', token: 't', model: 'qwen/qwen3.8-27b' };

  it('reports incompatible with the upstream sentence on a real 400', () => {
    return probeOpenRouterModelCompat({
      ...base,
      fetchImpl: fetchReturning(400, REAL_400_BODY),
    }).then((r) => {
      expect(r.compatible).toBe(false);
      expect(r.detail).toBe('System message must be at the beginning.');
    });
  });

  it('reports compatible on a 200', async () => {
    const r = await probeOpenRouterModelCompat({ ...base, fetchImpl: fetchReturning(200, {}) });
    expect(r).toEqual({ compatible: true });
  });

  it('stays quiet for auth, quota and server errors — those are not about the model', async () => {
    for (const status of [401, 403, 429, 500, 502]) {
      const r = await probeOpenRouterModelCompat({
        ...base,
        fetchImpl: fetchReturning(status, { error: { message: 'nope' } }),
      });
      expect(r.compatible, `status ${status}`).toBe(true);
    }
  });

  it('stays quiet when the endpoint is unreachable', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await probeOpenRouterModelCompat({ ...base, fetchImpl: boom })).toEqual({
      compatible: true,
    });
  });

  it('reports incompatible without a detail when the 400 body is unparseable', async () => {
    const r = await probeOpenRouterModelCompat({
      ...base,
      fetchImpl: fetchReturning(400, 'not json at all'),
    });
    expect(r).toEqual({ compatible: false });
  });

  it('sends the shape under test: a tool plus a TRAILING system message', async () => {
    let sent: Record<string, unknown> | null = null;
    const capture = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await probeOpenRouterModelCompat({ ...base, fetchImpl: capture });
    const body = sent as unknown as {
      messages: { role: string }[];
      tools: unknown[];
      max_tokens: number;
    };
    // If the probe stopped sending either of these it would silently pass every
    // model, which is the one failure mode that makes it worse than useless.
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(body.tools).toHaveLength(1);
    expect(body.max_tokens).toBe(1);
  });

  it('does not double the slash when the base URL has a trailing one', async () => {
    let url = '';
    const capture = (async (u: string) => {
      url = u;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await probeOpenRouterModelCompat({
      ...base,
      baseUrl: 'https://openrouter.ai/api/',
      fetchImpl: capture,
    });
    expect(url).toBe('https://openrouter.ai/api/v1/messages');
  });
});
