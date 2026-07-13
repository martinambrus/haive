import { describe, it, expect } from 'vitest';
import { httpErrorOutcome } from './types.js';

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
