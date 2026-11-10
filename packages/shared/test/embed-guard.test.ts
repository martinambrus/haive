import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONFIG_KEYS, configService } from '../src/config/index.js';
import { DEFAULT_EXTERNAL_OLLAMA_URL } from '../src/constants/index.js';
import { composeContainerName } from '../src/naming/index.js';
import {
  embedQuery,
  embedQueryOrNull,
  getOllamaModelPlacement,
  listResidentOllamaModels,
  ollamaEmbed,
  probeOllama,
  unloadOllamaModel,
  warmOllamaModel,
} from '../src/rag/embed.js';

let server: http.Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/embed') res.end(JSON.stringify({ embeddings: [[1]] }));
    else if (req.url === '/api/ps') res.end(JSON.stringify({ models: [] }));
    else res.end(JSON.stringify({ models: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
  hits = 0;
});

function allowlist(value: string) {
  vi.spyOn(configService, 'get').mockImplementation(async (key: string) =>
    key === CONFIG_KEYS.PRIVATE_ENDPOINT_ALLOWLIST ? value : '',
  );
}

const loop = () => `http://127.0.0.1:${port}`;

describe('Ollama helpers dial through the egress guard by default', () => {
  it('refuses a loopback target when the allowlist is empty (all six helpers)', async () => {
    allowlist('');
    expect(await probeOllama(loop())).toBe(false);
    await expect(ollamaEmbed(loop(), 'm', ['x'], { timeoutMs: 2000 })).rejects.toThrow();
    expect(await warmOllamaModel(loop(), 'm', 2000)).toBe(false);
    expect(await unloadOllamaModel(loop(), 'm', 2000)).toBe(false);
    expect(await listResidentOllamaModels(loop(), 2000)).toBeNull();
    expect(await getOllamaModelPlacement(loop(), 'm', 2000)).toBe('unreachable');
    expect(hits).toBe(0);
  });

  it('reports refused residency dials without changing the null result', async () => {
    allowlist('');
    const refused = vi.fn();
    expect(await listResidentOllamaModels(loop(), 2000, undefined, refused)).toBeNull();
    expect(refused).toHaveBeenCalledExactlyOnceWith();
    expect(hits).toBe(0);
  });

  it('reaches a loopback target the allowlist covers', async () => {
    allowlist('127.0.0.1');
    expect(await probeOllama(loop())).toBe(true);
    expect(await ollamaEmbed(loop(), 'm', ['x'], { timeoutMs: 2000 })).toEqual([[1]]);
    expect(hits).toBe(2);
  });

  it('exempts the in-stack names and not a literal loopback host', async () => {
    allowlist('');
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
    ] as never);
    expect(await probeOllama(`http://ollama:${port}`)).toBe(true);
    expect(await probeOllama(`http://${composeContainerName('ollama')}:${port}`)).toBe(true);
    expect(hits).toBe(2);
    expect(await probeOllama(loop())).toBe(false);
    expect(hits).toBe(2);
  });

  it('lets an explicit fetchFn win', async () => {
    allowlist('');
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const body = url.endsWith('/api/embed') ? { embeddings: [[1, 2]] } : { models: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await warmOllamaModel(loop(), 'm', 2000, fetchFn)).toBe(true);
    expect(await unloadOllamaModel(loop(), 'm', 2000, fetchFn)).toBe(true);
    expect(await listResidentOllamaModels(loop(), 2000, fetchFn)).toEqual([]);
    expect(await getOllamaModelPlacement(loop(), 'm', 2000, fetchFn)).toBe('not_resident');
    const opts = { ollamaUrl: loop(), model: 'm', dimensions: 2, fetchFn };
    expect(await embedQuery('q', opts)).toEqual([1, 2]);
    expect(await embedQueryOrNull('q', opts)).toEqual([1, 2]);
    expect(calls).toHaveLength(6);
    expect(hits).toBe(0);
  });

  it('dials the shipped external default as built in, with no allowlist read', async () => {
    allowlist('');
    // The lookup fails, so the dial never connects: port 11434 may answer on a developer machine.
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    expect(await probeOllama(DEFAULT_EXTERNAL_OLLAMA_URL)).toBe(false);
    expect(lookup).toHaveBeenCalledWith('host.docker.internal', { all: true });
    expect(vi.mocked(configService.get)).not.toHaveBeenCalledWith(
      CONFIG_KEYS.PRIVATE_ENDPOINT_ALLOWLIST,
    );
  });
});
