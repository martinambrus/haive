import { describe, expect, it } from 'vitest';
import { aliasSecretTokens } from './exec-core.js';

describe('aliasSecretTokens', () => {
  it('maps a Z.AI key stored as a secret onto the token the claude binary reads', () => {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://z', Z_AI_API_KEY: 'k' };
    aliasSecretTokens(env, { Z_AI_API_KEY: 'k' });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('k');
    expect(env.ANTHROPIC_API_KEY).toBe('k');
  });

  it('lets the Z.AI key win over an Anthropic token from envVars, as the adapter does', () => {
    const env: Record<string, string> = { ANTHROPIC_AUTH_TOKEN: 'old', Z_AI_API_KEY: 'k' };
    aliasSecretTokens(env, { Z_AI_API_KEY: 'k' });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('k');
  });

  it('leaves the env alone when no aliased key is a secret', () => {
    const env: Record<string, string> = { ANTHROPIC_AUTH_TOKEN: 't' };
    aliasSecretTokens(env, { OTHER_SECRET: 'x' });
    expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: 't' });
  });

  it('keeps the Ollama mapping: fills the placeholder, never an explicit token', () => {
    const placeholder: Record<string, string> = {
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      OLLAMA_API_KEY: 'o',
    };
    aliasSecretTokens(placeholder, { OLLAMA_API_KEY: 'o' });
    expect(placeholder.ANTHROPIC_AUTH_TOKEN).toBe('o');
    const explicit: Record<string, string> = { ANTHROPIC_AUTH_TOKEN: 'a', OLLAMA_API_KEY: 'o' };
    aliasSecretTokens(explicit, { OLLAMA_API_KEY: 'o' });
    expect(explicit.ANTHROPIC_AUTH_TOKEN).toBe('a');
  });
});
