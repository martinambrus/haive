import { beforeEach, expect, it, vi } from 'vitest';
import { endpointBody, oversizedJson } from '../../../tests/fixtures/endpoint-body.mjs';

// Lower the existing bounded-reader seam, keeping all HTTP and stream handling real.
vi.mock('../src/forge/index.js', async (original) => {
  const real = await original<typeof import('../src/forge/index.js')>();
  return {
    ...real,
    readForgeJson: vi.fn((res: Response, max = real.FORGE_RESPONSE_MAX_BYTES) =>
      real.readForgeJson(res, Math.min(max, 128)),
    ),
    readBounded: (res: Response, max: number) => real.readBounded(res, Math.min(max, 256)),
  };
});
import {
  OLLAMA_ERROR_MAX_BYTES,
  OLLAMA_EMBED_MAX_BYTES,
  ollamaEmbed,
  listResidentOllamaModels,
  getOllamaModelPlacement,
  probeOllama,
  warmOllamaModel,
  unloadOllamaModel,
} from '../src/rag/embed.js';
import { FORGE_RESPONSE_MAX_BYTES, readForgeJson } from '../src/forge/index.js';

beforeEach(() => vi.clearAllMocks());

it('pins the production JSON body bounds', () => {
  expect(FORGE_RESPONSE_MAX_BYTES).toBe(8 * 1024 * 1024);
  expect(OLLAMA_EMBED_MAX_BYTES).toBe(32 * 1024 * 1024);
  expect(OLLAMA_ERROR_MAX_BYTES).toBe(64 * 1024);
});

it('passes the dedicated production bound to the embedding JSON reader', async () => {
  await expect(
    ollamaEmbed('http://unused.invalid', 'm', ['q'], {
      fetchFn: async () => Response.json({ embeddings: [[1, 2]] }),
    }),
  ).resolves.toEqual([[1, 2]]);
  expect(readForgeJson).toHaveBeenLastCalledWith(expect.any(Response), 32 * 1024 * 1024);
});

it('rejects an oversized /api/embed success without returning its vectors', async () => {
  const endpoint = await endpointBody(200, oversizedJson({ embeddings: [[1, 2]] }));
  try {
    await expect(
      ollamaEmbed(endpoint.url, 'm', ['q'], { fetchFn: endpoint.fetchFn }),
    ).rejects.toThrow('response is larger than 128 bytes');
    expect(endpoint.cancelled).toBe(true);
  } finally {
    await endpoint.close();
  }
});

it('keeps the first 200 characters and size note from a bounded oversized embed error', async () => {
  const body = 'upstream diagnostic '.repeat(20);
  const endpoint = await endpointBody(500, body);
  try {
    await expect(
      ollamaEmbed(endpoint.url, 'm', ['q'], { fetchFn: endpoint.fetchFn }),
    ).rejects.toThrow(
      new Error(
        `Ollama embed failed (500): ${body.slice(0, 200)} (response is larger than 65536 bytes)`,
      ),
    );
    expect(endpoint.cancelled).toBe(true);
  } finally {
    await endpoint.close();
  }
});

it.each(['list', 'placement'] as const)('bounds /api/ps for %s', async (site) => {
  const endpoint = await endpointBody(
    200,
    oversizedJson({ models: [{ name: 'm', size_vram: 1 }] }),
  );
  try {
    const result =
      site === 'list'
        ? await listResidentOllamaModels(endpoint.url, 1000, endpoint.fetchFn)
        : await getOllamaModelPlacement(endpoint.url, 'm', 1000, endpoint.fetchFn);
    expect(result).toBe(site === 'list' ? null : 'unreachable');
    expect(readForgeJson).toHaveBeenLastCalledWith(expect.any(Response));
    expect(endpoint.cancelled).toBe(true);
  } finally {
    await endpoint.close();
  }
});

it.each([
  ['probe', 200],
  ['probe', 500],
  ['warm', 200],
  ['warm', 500],
  ['unload', 200],
  ['unload', 500],
  ['list', 500],
  ['placement', 500],
] as const)('cancels unread %s HTTP %i bodies beyond the test bound', async (site, status) => {
  const endpoint = await endpointBody(status, oversizedJson({}), true);
  try {
    const result =
      site === 'probe'
        ? await probeOllama(endpoint.url, endpoint.fetchFn)
        : site === 'warm'
          ? await warmOllamaModel(endpoint.url, 'm', 1000, endpoint.fetchFn)
          : site === 'unload'
            ? await unloadOllamaModel(endpoint.url, 'm', 1000, endpoint.fetchFn)
            : site === 'list'
              ? await listResidentOllamaModels(endpoint.url, 1000, endpoint.fetchFn)
              : await getOllamaModelPlacement(endpoint.url, 'm', 1000, endpoint.fetchFn);
    expect(result).toBe(
      site === 'list' ? null : site === 'placement' ? 'unreachable' : status === 200,
    );
    expect(endpoint.cancelled).toBe(true);
    await endpoint.upstreamClosed;
    expect(endpoint.closed).toBe(true);
  } finally {
    await endpoint.close();
  }
});

it('keeps short embed failures and successful vectors usable', async () => {
  const fetchFn = vi.fn(async () => new Response('model missing', { status: 404 }));
  await expect(ollamaEmbed('http://unused.invalid', 'm', ['q'], { fetchFn })).rejects.toThrow(
    'Ollama embed failed (404): model missing',
  );
  fetchFn.mockImplementation(async () => new Response('{"embeddings":[[1,2]]}'));
  await expect(ollamaEmbed('http://unused.invalid', 'm', ['q'], { fetchFn })).resolves.toEqual([
    [1, 2],
  ]);
});

it('does not echo invalid success JSON', async () => {
  await expect(
    ollamaEmbed('http://unused.invalid', 'm', ['q'], {
      fetchFn: async () => new Response('private-marker'),
    }),
  ).rejects.toThrow('response is not JSON');
});
