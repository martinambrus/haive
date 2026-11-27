import { expect, it, vi } from 'vitest';
import { endpointBody, oversizedJson } from '../../../tests/fixtures/endpoint-body.mjs';
vi.mock('@haive/shared/forge', async (original) => {
  const real = await original<typeof import('@haive/shared/forge')>();
  return {
    ...real,
    readBounded: (res: Response, max: number) => {
      expect(max).toBe(64 * 1024);
      return real.readBounded(res, 128);
    },
  };
});
import { probeOllamaEndpoint } from '../src/cli-adapters/ollama-probe.js';
import { probeOpenRouterModelCompat } from '../src/cli-adapters/openrouter-compat.js';

it.each([
  ['ollama', 200],
  ['openrouter', 200],
  ['openrouter', 401],
  ['openrouter', 500],
] as const)(
  'cancels unread user-set %s HTTP %i bodies beyond the test bound',
  async (site, status) => {
    const endpoint = await endpointBody(status, oversizedJson({}), true);
    try {
      const opts = { baseUrl: endpoint.url, token: 't', model: 'm', fetchImpl: endpoint.fetchFn };
      expect(
        site === 'ollama'
          ? await probeOllamaEndpoint(opts)
          : await probeOpenRouterModelCompat(opts),
      ).toEqual(site === 'ollama' ? { ok: true } : { compatible: true });
      expect(endpoint.cancelled).toBe(true);
      await endpoint.upstreamClosed;
    } finally {
      await endpoint.close();
    }
  },
);

it.each(['ollama', 'openrouter'] as const)(
  'already bounds %s error bodies (#1054)',
  async (site) => {
    const endpoint = await endpointBody(400, oversizedJson({ error: 'upstream-marker' }));
    try {
      const opts = { baseUrl: endpoint.url, token: 't', model: 'm', fetchImpl: endpoint.fetchFn };
      expect(
        site === 'ollama'
          ? await probeOllamaEndpoint(opts)
          : await probeOpenRouterModelCompat(opts),
      ).toEqual(site === 'ollama' ? { ok: false, detail: 'HTTP 400' } : { compatible: true });
      expect(endpoint.cancelled).toBe(true);
    } finally {
      await endpoint.close();
    }
  },
);
