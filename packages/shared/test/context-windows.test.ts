import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  resolveContextWindow,
} from '../src/cli-providers/context-windows.js';

describe('resolveContextWindow', () => {
  it('matches on the model id, longest match first', () => {
    expect(resolveContextWindow('gemini', 'gemini-2.5-pro')).toBe(1_048_576);
    expect(resolveContextWindow('claude-code', 'claude-sonnet-4-20250514')).toBe(200_000);
  });

  it('resolves vendor-prefixed OpenRouter slugs through the same substring table', () => {
    // This is why openrouter needs no MODEL_CONTEXT_WINDOWS entries of its own.
    expect(resolveContextWindow('openrouter', 'anthropic/claude-opus-5')).toBe(200_000);
    expect(resolveContextWindow('openrouter', 'openai/gpt-5.6')).toBe(400_000);
  });

  it('falls back to the provider window when no model matches', () => {
    expect(resolveContextWindow('openrouter', 'some/unheard-of-model')).toBe(200_000);
    expect(resolveContextWindow('ollama', 'mannix/gemma4-98e:CD-Q6_K')).toBe(128_000);
  });

  it('falls back to the global default for an unknown provider and model', () => {
    expect(resolveContextWindow('not-a-provider', null)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(resolveContextWindow(null, null)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('lets a provider-reported context length win over the substring guess', () => {
    // One OpenRouter provider row can point at anything from a 32k model to a 1M
    // one, so the gateway's own per-model number beats any table.
    expect(resolveContextWindow('openrouter', 'anthropic/claude-opus-5', 1_000_000)).toBe(
      1_000_000,
    );
    expect(resolveContextWindow('openrouter', 'vendor/tiny', 32_000)).toBe(32_000);
  });

  it('ignores a non-positive or non-finite reported length rather than dividing by zero', () => {
    // A stale cache can hand us null/0/NaN; each must fall through, never become
    // the window size.
    expect(resolveContextWindow('openrouter', 'anthropic/claude-opus-5', null)).toBe(200_000);
    expect(resolveContextWindow('openrouter', 'anthropic/claude-opus-5', 0)).toBe(200_000);
    expect(resolveContextWindow('openrouter', 'anthropic/claude-opus-5', -5)).toBe(200_000);
    expect(resolveContextWindow('openrouter', 'anthropic/claude-opus-5', Number.NaN)).toBe(200_000);
  });

  it('always returns a positive number so a percentage is safe to compute', () => {
    for (const [p, m] of [
      ['openrouter', 'x/y'],
      ['nope', 'nope'],
      [null, null],
    ] as const) {
      expect(resolveContextWindow(p, m)).toBeGreaterThan(0);
    }
  });
});
