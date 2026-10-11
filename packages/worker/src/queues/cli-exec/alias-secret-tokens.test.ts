import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../cli-adapters/claude-code.js';
import type { CliProviderRecord } from '../../cli-adapters/types.js';
import { ZaiAdapter } from '../../cli-adapters/zai.js';
import { aliasSecretTokens } from './exec-core.js';

describe('aliasSecretTokens', () => {
  it('maps a Z.AI key stored as a secret onto the token the claude binary reads', () => {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://z', Z_AI_API_KEY: 'k' };
    aliasSecretTokens(env, { Z_AI_API_KEY: 'k' }, 'Z_AI_API_KEY');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('k');
    expect(env.ANTHROPIC_API_KEY).toBe('k');
  });

  it('lets the Z.AI key win over an Anthropic token from envVars, as the adapter does', () => {
    const env: Record<string, string> = { ANTHROPIC_AUTH_TOKEN: 'old', Z_AI_API_KEY: 'k' };
    aliasSecretTokens(env, { Z_AI_API_KEY: 'k' }, 'Z_AI_API_KEY');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('k');
  });

  it('leaves another provider alone when it merely holds a Z.AI key as a secret', () => {
    const env: Record<string, string> = { ANTHROPIC_AUTH_TOKEN: 'own', Z_AI_API_KEY: 'k' };
    aliasSecretTokens(env, { Z_AI_API_KEY: 'k' });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('own');
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

describe('which spec asks for the Z.AI alias', () => {
  const provider = {
    wrapperPath: null,
    executablePath: null,
    cliArgs: [],
    envVars: {},
    effortLevel: null,
    model: null,
    disableThinking: false,
  } as unknown as CliProviderRecord;

  it('is only the Z.AI adapter', () => {
    expect(new ZaiAdapter().buildCliInvocation(provider, 'do x', {}).secretTokenAlias).toBe(
      'Z_AI_API_KEY',
    );
    expect(
      new ClaudeCodeAdapter().buildCliInvocation(provider, 'do x', {}).secretTokenAlias,
    ).toBeUndefined();
  });
});
