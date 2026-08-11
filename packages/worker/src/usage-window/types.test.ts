import { describe, it, expect } from 'vitest';
import { authDenialSeverity, httpErrorOutcome, jwtExpMs, nextAuthStrike } from './types.js';

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);

/** A JWT-shaped token carrying `payload`. Header and signature are never read, so any
 *  non-empty segments will do. */
function jwt(payload: Record<string, unknown>): string {
  const seg = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `header.${seg}.signature`;
}

describe('httpErrorOutcome', () => {
  it('flags 401/403 as authExpired so the poller stops re-hitting a dead token', () => {
    expect(httpErrorOutcome(401)).toEqual({
      ok: false,
      rateLimited: false,
      authExpired: true,
      error: 'http 401',
    });
    expect(httpErrorOutcome(403).authExpired).toBe(true);
  });

  it('leaves other statuses as plain (retryable) errors, not auth denials', () => {
    // 500 / 404 / network-shaped failures may be transient; gating them on the token
    // would hide the meter until a re-auth that isn't actually needed.
    expect(httpErrorOutcome(500).authExpired).toBe(false);
    expect(httpErrorOutcome(404).authExpired).toBe(false);
    expect(httpErrorOutcome(502).authExpired).toBe(false);
  });
});

describe('nextAuthStrike', () => {
  it('holds below the threshold so a transient 401/403 does not nag on the first hit', () => {
    expect(nextAuthStrike(0, 3)).toEqual({ strikes: 1, action: 'hold' });
    expect(nextAuthStrike(1, 3)).toEqual({ strikes: 2, action: 'hold' });
  });

  it('escalates once the consecutive-denial threshold is reached', () => {
    expect(nextAuthStrike(2, 3)).toEqual({ strikes: 3, action: 'escalate' });
    expect(nextAuthStrike(3, 3)).toEqual({ strikes: 4, action: 'escalate' });
  });
});

describe('jwtExpMs', () => {
  it('reads the exp claim in epoch ms', () => {
    expect(jwtExpMs(jwt({ exp: 1786522470 }))).toBe(1786522470_000);
  });

  it('returns null for a token that is not a JWT', () => {
    // gemini's oauth_creds.json holds an opaque Google bearer, not a JWT.
    expect(jwtExpMs('ya29.a0AfB_byC-not-a-jwt')).toBeNull();
    expect(jwtExpMs('')).toBeNull();
    expect(jwtExpMs('two.parts')).toBeNull();
    expect(jwtExpMs('header..signature')).toBeNull();
  });

  it('returns null when the payload is unreadable or carries no numeric exp', () => {
    expect(jwtExpMs('header.@@not-base64-json@@.signature')).toBeNull();
    expect(jwtExpMs(jwt({ sub: 'user-1' }))).toBeNull();
    expect(jwtExpMs(jwt({ exp: '1786522470' }))).toBeNull();
  });
});

describe('authDenialSeverity', () => {
  it('nags for a reconnectable provider whatever the token looks like', () => {
    // claude usage-OAuth / zai: the token only ever dies in ways a user action fixes.
    for (const token of [jwt({ exp: 1 }), 'ya29.opaque', '']) {
      expect(authDenialSeverity({ reconnectable: true, token, now: NOW })).toBe('reconnect');
    }
  });

  it('nags when a self-healing provider had a token rejected BEFORE its own expiry', () => {
    // The codex incident: 401 token_expired on a token with a day left on it, i.e. the
    // ChatGPT session was revoked server-side. Waiting for the CLI to refresh never fixes it.
    const unexpired = jwt({ exp: Math.floor(NOW / 1000) + 86_400 });
    expect(authDenialSeverity({ reconnectable: false, token: unexpired, now: NOW })).toBe(
      'reconnect',
    );
  });

  it('stays quiet when a self-healing provider let its token lapse', () => {
    const lapsed = jwt({ exp: Math.floor(NOW / 1000) - 60 });
    expect(authDenialSeverity({ reconnectable: false, token: lapsed, now: NOW })).toBe('silent');
    // Exactly at expiry is lapsed, not revoked.
    const justExpired = jwt({ exp: Math.floor(NOW / 1000) });
    expect(authDenialSeverity({ reconnectable: false, token: justExpired, now: NOW })).toBe(
      'silent',
    );
  });

  it('stays quiet when the token carries no readable expiry', () => {
    // No evidence of revocation -> keep the pre-existing hidden-error behaviour rather than
    // nagging a gemini user about a token Haive never logged them into.
    for (const token of ['ya29.opaque', 'garbage', jwt({ sub: 'user-1' })]) {
      expect(authDenialSeverity({ reconnectable: false, token, now: NOW })).toBe('silent');
    }
  });
});
