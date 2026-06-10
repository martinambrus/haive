import { describe, expect, it } from 'vitest';
import {
  extractGeminiJsonOutput,
  normalizeClaudeUsage,
  sumTokenUsage,
  tokenUsageFromCodexUsage,
} from '../src/cli-executor/usage-extract.js';

// The user has no Gemini API key — this fixture encodes the documented
// `gemini --output-format json` envelope and is the entire gemini coverage.
const TWO_MODEL_DOC = JSON.stringify({
  response: '```json\n{"a":1}\n```',
  stats: {
    models: {
      'gemini-2.5-pro': {
        api: { totalRequests: 2 },
        tokens: { prompt: 100, candidates: 40, total: 160, cached: 30, thoughts: 20, tool: 0 },
      },
      'gemini-2.5-flash': {
        tokens: { prompt: 10, candidates: 5, total: 15, cached: 0, thoughts: 0, tool: 0 },
      },
    },
  },
});

describe('extractGeminiJsonOutput', () => {
  it('unwraps the response and sums token usage across models (thoughts count as output)', () => {
    const out = extractGeminiJsonOutput(TWO_MODEL_DOC)!;
    expect(out.responseText).toBe('```json\n{"a":1}\n```');
    expect(out.tokenUsage).toEqual({
      inputTokens: 110,
      outputTokens: 65,
      totalTokens: 175,
      cacheReadTokens: 30,
    });
  });

  it('returns the response with null usage when stats are missing', () => {
    const out = extractGeminiJsonOutput(JSON.stringify({ response: 'hello' }))!;
    expect(out.responseText).toBe('hello');
    expect(out.tokenUsage).toBeNull();
  });

  it('returns null for non-JSON stdout (plain-text fallback)', () => {
    expect(extractGeminiJsonOutput('plain text answer')).toBeNull();
  });

  it('returns null when response is not a string', () => {
    expect(extractGeminiJsonOutput(JSON.stringify({ stats: {} }))).toBeNull();
    expect(extractGeminiJsonOutput(JSON.stringify({ response: 42 }))).toBeNull();
  });

  it('accepts an empty response string', () => {
    expect(extractGeminiJsonOutput(JSON.stringify({ response: '' }))!.responseText).toBe('');
  });
});

describe('normalizeClaudeUsage', () => {
  it('maps anthropic usage with cache fields into the provider-native shape', () => {
    expect(
      normalizeClaudeUsage({
        input_tokens: 5,
        output_tokens: 50,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      }),
    ).toEqual({
      inputTokens: 5,
      outputTokens: 50,
      totalTokens: 355,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
    });
  });

  it('returns null without input or output tokens', () => {
    expect(normalizeClaudeUsage({})).toBeNull();
    expect(normalizeClaudeUsage(null)).toBeNull();
    expect(normalizeClaudeUsage('usage')).toBeNull();
  });
});

describe('tokenUsageFromCodexUsage', () => {
  it('keeps cached inside inputTokens (OpenAI semantics) and mirrors it', () => {
    expect(
      tokenUsageFromCodexUsage({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }),
    ).toEqual({ inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cacheReadTokens: 800 });
  });

  it('returns null for empty objects', () => {
    expect(tokenUsageFromCodexUsage({})).toBeNull();
  });
});

describe('sumTokenUsage', () => {
  it('sums all fields and drops zero-valued optionals', () => {
    const a = { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.5 };
    const b = { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: 7 };
    expect(sumTokenUsage(a, b)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
      cacheReadTokens: 7,
      costUsd: 0.5,
    });
  });

  it('passes through single sides and null+null', () => {
    const a = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    expect(sumTokenUsage(a, null)).toBe(a);
    expect(sumTokenUsage(null, a)).toBe(a);
    expect(sumTokenUsage(null, null)).toBeNull();
  });
});
