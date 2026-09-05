import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OLLAMA_QUERY_TIMEOUT_MS,
  OLLAMA_TIMEOUT_MS,
  embedQuery,
  embedQueryOrNull,
  getOllamaModelPlacement,
  ollamaEmbed,
  resolveEmbedBudget,
} from './embed.js';

function mockPs(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mock /api/embed and capture every timeout `AbortSignal.timeout` was asked for,
 *  which is the only externally visible difference between the two budgets. */
function mockEmbed(vector: number[] | null) {
  const timeouts: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (vector === null) throw new Error('connection refused');
      return { ok: true, json: async () => ({ embeddings: [vector] }) };
    }) as unknown as typeof fetch,
  );
  return timeouts;
}

describe('embed budgets', () => {
  it('falls back to the constants when ConfigService is not initialized', async () => {
    // rag-eval.ts imports this module standalone; a throw there would break a
    // diagnostic script over a setting it never sets.
    const budget = await resolveEmbedBudget();
    expect(budget.embedTimeoutMs).toBe(OLLAMA_TIMEOUT_MS);
    expect(budget.queryTimeoutMs).toBe(OLLAMA_QUERY_TIMEOUT_MS);
    expect(budget.batchSize).toBe(8);
    // Strict must default ON, or an uninitialized process silently hash-poisons.
    expect(budget.strict).toBe(true);
  });

  it('separates the ingest budget from the interactive query budget', () => {
    // The bug this feature exists for: one shared 60s budget was simultaneously too
    // tight for a CPU ingest batch (measured 50-69s) and far too loose for a search.
    expect(OLLAMA_TIMEOUT_MS).toBeGreaterThan(OLLAMA_QUERY_TIMEOUT_MS);
  });

  it('ollamaEmbed uses the ingest budget by default', async () => {
    const timeouts = mockEmbed([0.1, 0.2]);
    await ollamaEmbed('http://x', 'm', ['chunk']);
    expect(timeouts).toContain(OLLAMA_TIMEOUT_MS);
    expect(timeouts).not.toContain(OLLAMA_QUERY_TIMEOUT_MS);
  });

  it('ollamaEmbed honours an explicit timeout', async () => {
    const timeouts = mockEmbed([0.1]);
    await ollamaEmbed('http://x', 'm', ['chunk'], { timeoutMs: 1234 });
    expect(timeouts).toContain(1234);
  });

  it('a query embed uses the query budget, never the ingest one', async () => {
    const timeouts = mockEmbed([0.1, 0.2]);
    await embedQueryOrNull('where is auth', { ollamaUrl: 'http://x', model: 'm', dimensions: 4 });
    expect(timeouts).toContain(OLLAMA_QUERY_TIMEOUT_MS);
    expect(timeouts).not.toContain(OLLAMA_TIMEOUT_MS);
  });
});

describe('embedQueryOrNull', () => {
  it('returns null when the embed fails, so the caller can drop to lexical-only', async () => {
    mockEmbed(null);
    expect(
      await embedQueryOrNull('q', { ollamaUrl: 'http://x', model: 'm', dimensions: 4 }),
    ).toBeNull();
  });

  it('returns null when no endpoint is configured', async () => {
    expect(await embedQueryOrNull('q', { ollamaUrl: null, model: null, dimensions: 4 })).toBeNull();
  });

  it('embedQuery still hash-falls-back, for callers that need a vector of the width', async () => {
    mockEmbed(null);
    const vec = await embedQuery('q', { ollamaUrl: 'http://x', model: 'm', dimensions: 4 });
    expect(vec).toHaveLength(4);
  });
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
