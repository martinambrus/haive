import { describe, it, expect } from 'vitest';
import { subscriptionClaudeIsAlready1h } from './invocation-cost.js';

// Anthropic gives subscription auth the 1-hour prompt cache unconditionally, so the
// 5-minute write rate understates those writes by 1.6x on claude-opus-5. The flag that
// looked like it governed this (PROMPT_CACHING_1H) opts API-key/Bedrock/Vertex runs INTO
// the 1h TTL and is a no-op on subscription — so its default-off state under-priced every
// subscription run rather than protecting it from the 2x rate.
describe('subscriptionClaudeIsAlready1h', () => {
  it('claims the 1h rate for subscription claude-code — the case the flag never covered', () => {
    expect(subscriptionClaudeIsAlready1h('claude-code', 'subscription')).toBe(true);
  });

  it('leaves API-key claude-code to the flag, which is what the flag is FOR', () => {
    expect(subscriptionClaudeIsAlready1h('claude-code', 'api_key')).toBe(false);
  });

  // The claude-family wrappers run the same binary against endpoints with their own
  // caching, so Anthropic's TTL says nothing about them. They also report no
  // cache-creation tokens at all, so this only ever mattered for claude-code.
  it('says nothing about the claude-family wrappers, whose endpoints are not Anthropic', () => {
    for (const provider of ['zai', 'ollama', 'muse', 'openrouter']) {
      expect(subscriptionClaudeIsAlready1h(provider, 'subscription')).toBe(false);
    }
  });

  it('says nothing about providers that report no cache writes', () => {
    expect(subscriptionClaudeIsAlready1h('codex', 'subscription')).toBe(false);
    expect(subscriptionClaudeIsAlready1h('gemini', 'subscription')).toBe(false);
  });

  it('is false when either half is unknown, so an unattributable row keeps the old path', () => {
    expect(subscriptionClaudeIsAlready1h(null, 'subscription')).toBe(false);
    expect(subscriptionClaudeIsAlready1h('claude-code', null)).toBe(false);
  });
});
