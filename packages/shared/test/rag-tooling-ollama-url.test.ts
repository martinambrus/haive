import { describe, expect, it } from 'vitest';
import { resolveToolingOllamaUrl } from '../src/rag/connection.js';
import { IN_STACK_OLLAMA_URL } from '../src/constants/index.js';

describe('resolveToolingOllamaUrl', () => {
  it('re-derives the in-stack URL a committed mirror stripped', () => {
    // Exactly the shape restored from `.haive-data/tooling.json`: ollamaMode survives
    // the ONBOARDING_TOOLING_INFRA_KEYS strip, ollamaUrl does not.
    const out = resolveToolingOllamaUrl({
      ollamaMode: 'internal',
      embeddingModel: 'qwen3-embedding:4b',
    } as Record<string, unknown>);

    expect(out.url).toBe(IN_STACK_OLLAMA_URL);
    // `derived` is the only provenance signal that this repo's existing rows are
    // hash vectors, so the indexer can force exactly one re-embed.
    expect(out.derived).toBe(true);
  });

  it('keeps a stored URL and reports it as not derived', () => {
    const out = resolveToolingOllamaUrl({
      ollamaMode: 'internal',
      ollamaUrl: 'http://ollama:11434',
    });

    expect(out.url).toBe('http://ollama:11434');
    expect(out.derived).toBe(false);
  });

  it('never invents a URL for an external daemon', () => {
    // 'external' carries a user-typed, genuinely machine-specific address; guessing
    // the in-stack one would point the indexer at the wrong daemon.
    const out = resolveToolingOllamaUrl({ ollamaMode: 'external' });

    expect(out.url).toBeNull();
    expect(out.derived).toBe(false);
  });

  it('returns nothing for tooling that names no mode at all', () => {
    const out = resolveToolingOllamaUrl({});

    expect(out.url).toBeNull();
    expect(out.derived).toBe(false);
  });
});
