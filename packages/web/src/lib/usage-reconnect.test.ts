import { describe, it, expect } from 'vitest';
import { usageReconnectFix, usageReconnectHref, usageReconnectHint } from './usage-reconnect';

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
    expect(usageReconnectHref('p1', 'claude-code')).toBe(
      '/settings/cli-providers/p1#usage-tracking',
    );
  });

  it('anchors an interactive-login CLI at the card holding its Log in button', () => {
    // Landing on the edit form instead leaves the user hunting for a control that is not
    // visible until they think to run a Test first.
    expect(usageReconnectHref('p1', 'codex')).toBe('/settings/cli-providers/p1#cli-login');
    expect(usageReconnectHref('p1', 'amp')).toBe('/settings/cli-providers/p1#cli-login');
  });

  it('anchors a BYOK provider at the credential field, not the top of the edit form', () => {
    // Nothing to open for these — no OAuth page, no login TUI — so the closest thing to
    // starting the repair is landing on (and focusing) the field the new key is pasted into.
    expect(usageReconnectHref('p1', 'zai')).toBe('/settings/cli-providers/p1#secrets');
    expect(usageReconnectHref('p1', null)).toBe('/settings/cli-providers/p1#secrets');
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
