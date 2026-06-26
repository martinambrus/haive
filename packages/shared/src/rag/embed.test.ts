import { describe, it, expect, vi, afterEach } from 'vitest';
import { getOllamaModelPlacement } from './embed.js';

function mockPs(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getOllamaModelPlacement', () => {
  it('reports gpu when size_vram > 0', async () => {
    mockPs({ models: [{ name: 'qwen3-embedding:4b', size_vram: 123 }] });
    expect(await getOllamaModelPlacement('http://x', 'qwen3-embedding:4b')).toBe('gpu');
  });

  it('reports cpu when the model is resident with size_vram 0 (the driver-skew case)', async () => {
    mockPs({ models: [{ name: 'qwen3-embedding:4b', size_vram: 0 }] });
    expect(await getOllamaModelPlacement('http://x', 'qwen3-embedding:4b')).toBe('cpu');
  });

  it('matches on the model field as well as name', async () => {
    mockPs({ models: [{ model: 'qwen3-embedding:4b', size_vram: 0 }] });
    expect(await getOllamaModelPlacement('http://x', 'qwen3-embedding:4b')).toBe('cpu');
  });

  it('reports not_resident when the model is not loaded', async () => {
    mockPs({ models: [{ name: 'other:1b', size_vram: 10 }] });
    expect(await getOllamaModelPlacement('http://x', 'qwen3-embedding:4b')).toBe('not_resident');
  });

  it('treats a missing size_vram as cpu (no GPU layers reported)', async () => {
    mockPs({ models: [{ name: 'qwen3-embedding:4b' }] });
    expect(await getOllamaModelPlacement('http://x', 'qwen3-embedding:4b')).toBe('cpu');
  });

  it('reports unreachable on a non-ok response', async () => {
    mockPs({}, false);
    expect(await getOllamaModelPlacement('http://x', 'm')).toBe('unreachable');
  });

  it('reports unreachable when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    );
    expect(await getOllamaModelPlacement('http://x', 'm')).toBe('unreachable');
  });
});
