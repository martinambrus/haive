import { describe, expect, it } from 'vitest';
import { probeOllamaEndpoint } from '../src/cli-adapters/ollama-probe.js';
import {
  OLLAMA_CLOUD_URL,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_THINKING_PROXY_URL,
  resolveOllamaBaseUrl,
} from '../src/cli-adapters/ollama-thinking-proxy.js';

/** Bodies MEASURED against the live endpoints from inside the worker container, not
 *  invented: the local daemon at http://ollama:11434 and Ollama Cloud. Both error
 *  shapes are `{type:"error",error:{type,message}}`; a 200 carries the message. */
const OK_BODY =
  '{"id":"msg_1","type":"message","role":"assistant","model":"qwen3:1.7b",' +
  '"content":null,"stop_reason":"max_tokens","usage":{"input_tokens":11,"output_tokens":1}}';
const NOT_FOUND_BODY =
  '{"type":"error","error":{"type":"not_found_error","message":"model \'no-such-model:9b\' not found"}}';
const UNAUTHORIZED_BODY =
  '{"type":"error","error":{"type":"authentication_error","message":"Unauthorized"}}';

function fakeFetch(status: number, body: string): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

/** What undici actually throws for an unreachable host: a bare "fetch failed" whose
 *  cause carries the only useful part, and whose message is empty. */
function throwingFetch(code: string): typeof fetch {
  return (async () => {
    const err = new TypeError('fetch failed');
    (err as Error & { cause?: unknown }).cause = { code, message: '' };
    throw err;
  }) as typeof fetch;
}

const probe = (fetchImpl: typeof fetch) =>
  probeOllamaEndpoint({
    baseUrl: 'http://ollama:11434',
    token: 'ollama',
    model: 'qwen3:1.7b',
    fetchImpl,
  });

describe('probeOllamaEndpoint', () => {
  it('passes when the endpoint answers', async () => {
    expect(await probe(fakeFetch(200, OK_BODY))).toEqual({ ok: true });
  });

  it('reports an unreachable endpoint by its transport code', async () => {
    // The whole reason this probe exists: a provider pointed at http://localhost:11434
    // tested green and then failed every step with "API Error: Connection refused",
    // because localhost inside a sandbox is the sandbox.
    const result = await probe(throwingFetch('ECONNREFUSED'));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it("reports a missing model in the endpoint's own words", async () => {
    const result = await probe(fakeFetch(404, NOT_FOUND_BODY));
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("HTTP 404: model 'no-such-model:9b' not found");
  });

  it('reports a rejected key rather than treating it as inconclusive', async () => {
    // Deliberately unlike probeOpenRouterModelCompat, which passes 401 through as
    // green: that probe judges only the request SHAPE, this one judges whether the
    // provider can serve a request at all.
    const result = await probe(fakeFetch(401, UNAUTHORIZED_BODY));
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('HTTP 401: Unauthorized');
  });

  it('still names the status when the body is not JSON', async () => {
    const result = await probe(fakeFetch(502, '<html>bad gateway</html>'));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('HTTP 502');
  });
});

describe('resolveOllamaBaseUrl', () => {
  it('sends a local model to the in-stack daemon', () => {
    expect(resolveOllamaBaseUrl({}, { model: 'qwen3:1.7b', disableThinking: false })).toBe(
      OLLAMA_DEFAULT_BASE_URL,
    );
  });

  it('sends a cloud model to Ollama Cloud', () => {
    expect(resolveOllamaBaseUrl({}, { model: 'gemma4:31b-cloud', disableThinking: false })).toBe(
      OLLAMA_CLOUD_URL,
    );
  });

  it('routes a thinking-disabled cloud model through the sidecar', () => {
    expect(resolveOllamaBaseUrl({}, { model: 'gemma4:31b-cloud', disableThinking: true })).toBe(
      OLLAMA_THINKING_PROXY_URL,
    );
  });

  it('lets a hand-set base URL win over every rule', () => {
    const env = { ANTHROPIC_BASE_URL: 'http://localhost:11434' };
    expect(resolveOllamaBaseUrl(env, { model: 'gemma4:31b-cloud', disableThinking: true })).toBe(
      'http://localhost:11434',
    );
  });
});
