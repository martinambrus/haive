import { describe, expect, it } from 'vitest';
import { splitSecretLikeEnv } from '../src/constants/secret-env.js';

describe('splitSecretLikeEnv', () => {
  it.each(['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL'])(
    'moves a name holding %s in any case',
    (word) => {
      const names = [
        `X_${word}`,
        `x_${word.toLowerCase()}`,
        `X_${word[0]}${word.slice(1).toLowerCase()}_Y`,
      ];
      const { envVars, secrets } = splitSecretLikeEnv(
        Object.fromEntries(names.map((n) => [n, 'v'])),
      );
      expect(envVars).toEqual({});
      expect(Object.keys(secrets).sort()).toEqual([...names].sort());
    },
  );

  it('keeps configuration names in envVars', () => {
    const config = {
      ANTHROPIC_BASE_URL: 'u',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm',
      ANTHROPIC_MODEL: 'm',
      API_TIMEOUT_MS: '1',
      GROK_FOLDER_TRUST: '1',
    };
    expect(splitSecretLikeEnv(config)).toEqual({ envVars: config, secrets: {} });
  });

  it('moves CLAUDE_CODE_MAX_OUTPUT_TOKENS, a known false positive the form shares', () => {
    expect(splitSecretLikeEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' })).toEqual({
      envVars: {},
      secrets: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
    });
  });

  it('splits a mixed set and keeps values untouched', () => {
    expect(splitSecretLikeEnv({ ANTHROPIC_BASE_URL: 'u', ANTHROPIC_API_KEY: 'k' })).toEqual({
      envVars: { ANTHROPIC_BASE_URL: 'u' },
      secrets: { ANTHROPIC_API_KEY: 'k' },
    });
  });
});
