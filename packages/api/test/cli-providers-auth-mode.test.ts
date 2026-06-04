import { describe, expect, it } from 'vitest';
import { assertAuthModeSupported } from '../src/routes/cli-providers.js';
import { HttpError } from '../src/context.js';

describe('assertAuthModeSupported', () => {
  it('rejects subscription for gemini (BYOK-only, defaultAuthMode=api_key)', () => {
    expect(() => assertAuthModeSupported('gemini', 'subscription')).toThrow(HttpError);
  });

  it('rejects subscription for zai (api-key-only)', () => {
    expect(() => assertAuthModeSupported('zai', 'subscription')).toThrow(HttpError);
  });

  it('allows api_key for gemini', () => {
    expect(() => assertAuthModeSupported('gemini', 'api_key')).not.toThrow();
  });

  it('allows subscription for a CLI-login provider (claude-code)', () => {
    expect(() => assertAuthModeSupported('claude-code', 'subscription')).not.toThrow();
  });

  it('rejects api_key for a provider with no apiKeyEnvName (amp)', () => {
    expect(() => assertAuthModeSupported('amp', 'api_key')).toThrow(HttpError);
  });

  it('allows subscription for antigravity', () => {
    expect(() => assertAuthModeSupported('antigravity', 'subscription')).not.toThrow();
  });

  it('rejects api_key for antigravity (subscription-only, apiKeyEnvName null)', () => {
    expect(() => assertAuthModeSupported('antigravity', 'api_key')).toThrow(HttpError);
  });
});
