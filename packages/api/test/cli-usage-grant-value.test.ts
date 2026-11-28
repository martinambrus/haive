import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isUsageGrantValue, isUsageGrantSecret } from '../src/lib/usage-grant-set.js';

const rnd = () => randomBytes(16).toString('hex');
const grant = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    accessToken: rnd(),
    refreshToken: rnd(),
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:profile'],
    ...over,
  });

describe('a pasted usage grant', () => {
  it('is accepted in the shape the poller reads', () => {
    expect(isUsageGrantValue(grant())).toBe(true);
  });

  it('is accepted with an empty refresh token, which the poller uses without refreshing', () => {
    expect(isUsageGrantValue(grant({ refreshToken: '' }))).toBe(true);
  });

  it.each([
    ['not JSON', () => `plain-${rnd()}`],
    ['a JSON array', () => '[]'],
    ['missing the access token', () => grant({ accessToken: undefined })],
    ['an empty access token', () => grant({ accessToken: '' })],
    ['missing the refresh token', () => grant({ refreshToken: undefined })],
    ['a non-numeric expiry', () => grant({ expiresAt: 'soon' })],
    ['scopes that are not an array', () => grant({ scopes: 'user:profile' })],
    ['a scope that is not a string', () => grant({ scopes: [1] })],
  ])('is refused when it is %s', (_n, make) => {
    expect(isUsageGrantValue(make())).toBe(false);
  });
});

it.each(['claude-code', 'codex', 'grok', 'zai'])(
  'recognizes usage grants only for Claude in the library (%s)',
  (name) => {
    expect(isUsageGrantSecret(name, 'CLAUDE_USAGE_OAUTH')).toBe(name === 'claude-code');
    expect(isUsageGrantSecret(name, 'CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
  },
);
