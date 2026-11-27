import { describe, expect, it } from 'vitest';
import { hasUsageWindow } from '../src/cli-providers/usage-window.js';

describe('usage-window eligibility', () => {
  it.each(['api_key', null, undefined])(
    'requires explicit subscription auth for Claude (%s)',
    (mode) => {
      expect(hasUsageWindow('claude-code', mode)).toBe(false);
    },
  );

  it('allows subscription Claude', () => {
    expect(hasUsageWindow('claude-code', 'subscription')).toBe(true);
  });

  it.each(['codex', 'gemini', 'zai'])('preserves both auth modes for %s', (name) => {
    expect(hasUsageWindow(name, 'subscription')).toBe(true);
    expect(hasUsageWindow(name, 'api_key')).toBe(true);
  });

  it.each(['ollama', 'grok', 'amp', 'antigravity', 'toString', null, undefined])(
    'has no snapshot expectation for %s',
    (name) => expect(hasUsageWindow(name, 'subscription')).toBe(false),
  );
});
