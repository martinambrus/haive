import { describe, expect, it } from 'vitest';
import { formatOutputTokens, formatTokensAtLeast, fullTokens } from './format-tokens.js';

describe('formatOutputTokens', () => {
  it('renders an unknown output as a dash, never zero', () => {
    expect(formatOutputTokens(null)).toBe('—');
    expect(formatOutputTokens(undefined, 3)).toBe('—');
  });

  it('keeps a known zero and marks a lower bound', () => {
    expect(formatOutputTokens(0)).toBe('0');
    expect(formatOutputTokens(5, 2)).toBe('≥ 5');
    expect(formatOutputTokens(1500)).toBe('1.5k');
  });
});

describe('formatTokensAtLeast', () => {
  it('prefixes only when a run is unknown', () => {
    expect(formatTokensAtLeast(1500)).toBe('1.5k');
    expect(formatTokensAtLeast(1500, 1)).toBe('≥ 1.5k');
  });
});

describe('fullTokens', () => {
  it('spells unknown and at-least for tooltips', () => {
    expect(fullTokens(null)).toBe('unknown');
    expect(fullTokens(0)).toBe('0');
    expect(fullTokens(1234, 0)).toBe((1234).toLocaleString());
    expect(fullTokens(1234, 2)).toBe(`at least ${(1234).toLocaleString()}`);
  });
});
