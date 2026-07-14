import { describe, it, expect } from 'vitest';
import { httpErrorOutcome, nextAuthStrike } from './types.js';

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
