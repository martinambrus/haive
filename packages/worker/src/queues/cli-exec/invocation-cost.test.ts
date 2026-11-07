import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Database } from '@haive/database';
import { CONFIG_KEYS, ConfigUnavailableError, configService } from '@haive/shared';
import { resolveInvocationCost, subscriptionClaudeIsAlready1h } from './invocation-cost.js';

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

// The cache-write rate is persisted on the invocation row, so a store that cannot be read must
// not be answered with the 5m guess: the cost resolution rejects and the row stays unpriced.
describe('cache TTL resolution when the config store is unreadable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubDb(authMode: string): Database {
    return {
      query: {
        cliProviders: { findFirst: async () => ({ authMode, model: null }) },
        cliPricingSync: { findFirst: async () => undefined },
      },
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as unknown as Database;
  }

  const input = {
    cliProviderId: 'prov-1',
    providerName: 'claude-code',
    tokenUsage: { inputTokens: 1, outputTokens: 1 } as never,
    modelIdentity: null,
  };

  it('rejects with the outage error instead of pricing cache writes at 5m', async () => {
    const outage = new ConfigUnavailableError('get boolean');
    const spy = vi.spyOn(configService, 'getBoolean').mockRejectedValue(outage);
    await expect(resolveInvocationCost(stubDb('api_key'), input)).rejects.toBe(outage);
    expect(spy).toHaveBeenCalledWith(CONFIG_KEYS.PROMPT_CACHING_1H, false);
  });

  it('still prices at 5m when the read fails for any other reason', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(new Error('ConfigService not ready'));
    const cost = await resolveInvocationCost(stubDb('api_key'), input);
    expect(cost?.cacheTtl).toBe('5m');
  });

  it('uses 1h for subscription claude-code without reading the config at all', async () => {
    const spy = vi
      .spyOn(configService, 'getBoolean')
      .mockRejectedValue(new ConfigUnavailableError('get boolean'));
    const cost = await resolveInvocationCost(stubDb('subscription'), input);
    expect(cost?.cacheTtl).toBe('1h');
    expect(spy).not.toHaveBeenCalled();
  });
});
