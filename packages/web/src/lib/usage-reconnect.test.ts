import { describe, it, expect } from 'vitest';
import {
  cliLoginOffered,
  storedLoginStatus,
  usageReconnectFix,
  usageReconnectHref,
  usageReconnectHint,
} from './usage-reconnect';

describe('usageReconnectFix', () => {
  it('sends claude-code to its usage-OAuth, not to its CLI login', () => {
    // The meters run on a separately-minted usage token; `claude login` does not touch it.
    expect(usageReconnectFix('claude-code')).toBe('usage-oauth');
  });

  it('sends the interactive-login CLIs to their Log in button', () => {
    expect(usageReconnectFix('codex')).toBe('cli-login');
    expect(usageReconnectFix('amp')).toBe('cli-login');
    expect(usageReconnectFix('antigravity')).toBe('cli-login');
    // grok's SuperGrok device-code login. Membership in CLI_LOGIN_PROVIDERS is what
    // renders every login affordance; without it a subscription row probes auth_expired
    // ("credentials expired — please sign in again") and offers no way to sign in.
    expect(usageReconnectFix('grok')).toBe('cli-login');
  });

  it('sends the rest to their API token', () => {
    expect(usageReconnectFix('zai')).toBe('api-token');
    expect(usageReconnectFix('gemini')).toBe('api-token');
    expect(usageReconnectFix(null)).toBe('api-token');
    expect(usageReconnectFix(undefined)).toBe('api-token');
  });
});

describe('usageReconnectHref', () => {
  it('anchors claude-code at the Usage tracking section', () => {
    expect(usageReconnectHref('p1', 'claude-code')).toBe('/cli-providers/p1#usage-tracking');
  });

  it('anchors an interactive-login CLI at the card holding its Log in button', () => {
    // Landing on the edit form instead leaves the user hunting for a control that is not
    // visible until they think to run a Test first.
    expect(usageReconnectHref('p1', 'codex')).toBe('/cli-providers/p1#cli-login');
    expect(usageReconnectHref('p1', 'amp')).toBe('/cli-providers/p1#cli-login');
  });

  it('anchors a BYOK provider at the credential field, not the top of the edit form', () => {
    // Nothing to open for these — no OAuth page, no login TUI — so the closest thing to
    // starting the repair is landing on (and focusing) the field the new key is pasted into.
    expect(usageReconnectHref('p1', 'zai')).toBe('/cli-providers/p1#secrets');
    expect(usageReconnectHref('p1', null)).toBe('/cli-providers/p1#secrets');
  });
});

describe('usageReconnectHint', () => {
  it('names Log in for codex rather than an API token it does not have', () => {
    const hint = usageReconnectHint('Codex', 'codex');
    expect(hint).toContain('Log in');
    expect(hint).not.toContain('API token');
  });

  it('names the API token for a BYOK provider', () => {
    expect(usageReconnectHint('Z.ai', 'zai')).toContain('replace its API token');
  });

  it('names Usage tracking for claude-code', () => {
    expect(usageReconnectHint('Claude', 'claude-code')).toContain('Usage tracking');
  });

  it('mentions a new tab only where the surface opens one', () => {
    expect(usageReconnectHint('Codex', 'codex', { newTab: true })).toContain('in a new tab');
    expect(usageReconnectHint('Codex', 'codex')).not.toContain('in a new tab');
  });

  it('falls back to a generic subject when the provider has no label', () => {
    expect(usageReconnectHint(null, 'codex')).toMatch(/^This CLI /);
  });
});

describe('cliLoginOffered', () => {
  const base = {
    name: 'codex' as const,
    authMode: 'subscription' as const,
    testStatus: undefined,
    rowStatus: undefined,
    usageTokenDead: false,
  };
  it('offers Log in from the row alone after a sign-out wrote unknown', () => {
    expect(cliLoginOffered({ ...base, rowStatus: 'unknown' })).toBe(true);
    expect(cliLoginOffered({ ...base, rowStatus: 'auth_expired' })).toBe(true);
  });
  it('does not offer it for a logged-in row or one with no status', () => {
    expect(cliLoginOffered({ ...base, rowStatus: 'ok' })).toBe(false);
    expect(cliLoginOffered({ ...base, rowStatus: null })).toBe(false);
    expect(cliLoginOffered({ ...base, rowStatus: 'rate_limited' })).toBe(false);
  });
  it('lets a fresh Test result win over the stored row', () => {
    expect(cliLoginOffered({ ...base, rowStatus: 'unknown', testStatus: 'ok' })).toBe(false);
    expect(cliLoginOffered({ ...base, rowStatus: 'ok', testStatus: 'auth_expired' })).toBe(true);
  });
  it('never offers it from an api_key row alone, but a Test result still can', () => {
    expect(cliLoginOffered({ ...base, authMode: 'api_key', rowStatus: 'unknown' })).toBe(false);
    expect(
      cliLoginOffered({
        ...base,
        authMode: 'api_key',
        rowStatus: 'unknown',
        testStatus: 'auth_expired',
      }),
    ).toBe(true);
  });
  it('offers it for a dead usage token whatever the status', () => {
    expect(cliLoginOffered({ ...base, rowStatus: 'ok', usageTokenDead: true })).toBe(true);
  });
  it('never offers it for a provider with no interactive login', () => {
    expect(cliLoginOffered({ ...base, name: 'gemini', rowStatus: 'unknown' })).toBe(false);
  });
});

describe('storedLoginStatus', () => {
  const row = (
    id: string,
    authStatus: 'ok' | 'unknown' | 'auth_expired',
    authLastCheckedAt: string | null,
    extra: { isolateAuth?: boolean; name?: 'codex' | 'claude-code'; userId?: string } = {},
  ) => ({
    id,
    userId: extra.userId ?? 'u',
    name: extra.name ?? ('codex' as const),
    authMode: 'subscription' as const,
    isolateAuth: extra.isolateAuth ?? false,
    authStatus,
    authLastCheckedAt,
  });
  const signedOutAt = '2026-01-02T10:00:00.000Z';
  const loggedInAt = '2026-01-02T10:00:39.000Z';

  it('keeps unknown while every row sharing the login was signed out together', () => {
    const rows = [row('a', 'unknown', signedOutAt), row('b', 'unknown', signedOutAt)];
    expect(storedLoginStatus(rows[0]!, rows)).toBe('unknown');
    expect(storedLoginStatus(rows[1]!, rows)).toBe('unknown');
  });
  it('reads ok once a sibling on the shared login checked ok after the sign-out', () => {
    const rows = [row('a', 'ok', loggedInAt), row('b', 'unknown', signedOutAt)];
    expect(storedLoginStatus(rows[1]!, rows)).toBe('ok');
    expect(storedLoginStatus(row('c', 'unknown', null), rows)).toBe('ok');
  });
  it('keeps a row that saw the login fail after the sibling last checked ok', () => {
    const rows = [row('a', 'ok', signedOutAt), row('b', 'auth_expired', loggedInAt)];
    expect(storedLoginStatus(rows[1]!, rows)).toBe('auth_expired');
  });
  it('ignores a sibling that does not share the auth volume', () => {
    const own = row('b', 'unknown', signedOutAt);
    expect(storedLoginStatus(own, [row('a', 'ok', loggedInAt, { isolateAuth: true })])).toBe(
      'unknown',
    );
    expect(storedLoginStatus(own, [row('a', 'ok', loggedInAt, { name: 'claude-code' })])).toBe(
      'unknown',
    );
    expect(storedLoginStatus(own, [row('a', 'ok', loggedInAt, { userId: 'other' })])).toBe(
      'unknown',
    );
    const isolated = row('b', 'unknown', signedOutAt, { isolateAuth: true });
    expect(storedLoginStatus(isolated, [row('a', 'ok', loggedInAt)])).toBe('unknown');
  });
});
