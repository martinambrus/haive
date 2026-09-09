import { describe, expect, it } from 'vitest';
import { inviteStatus, isRevocable, type InviteTimestamps } from './invite-status';

const NOW = new Date('2026-09-09T12:00:00Z');
const HOUR = 3_600_000;

function invite(over: Partial<InviteTimestamps> = {}): InviteTimestamps {
  return {
    revokedAt: null,
    consumedAt: null,
    expiresAt: new Date(NOW.getTime() + HOUR).toISOString(),
    ...over,
  };
}

describe('inviteStatus', () => {
  it('calls an unused, unexpired, unrevoked invite live', () => {
    expect(inviteStatus(invite(), NOW)).toBe('live');
  });

  it('reads each terminal state', () => {
    expect(inviteStatus(invite({ revokedAt: NOW.toISOString() }), NOW)).toBe('revoked');
    expect(inviteStatus(invite({ consumedAt: NOW.toISOString() }), NOW)).toBe('consumed');
    expect(inviteStatus(invite({ expiresAt: NOW.toISOString() }), NOW)).toBe('expired');
  });

  // A row can hold several of these at once, so the order has to be fixed rather than incidental —
  // and it is the order the server's own `checkInvite` reports.
  it('reports the most deliberate reason when several apply', () => {
    const all = invite({
      revokedAt: NOW.toISOString(),
      consumedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() - HOUR).toISOString(),
    });
    expect(inviteStatus(all, NOW)).toBe('revoked');
    expect(inviteStatus({ ...all, revokedAt: null }, NOW)).toBe('consumed');
  });

  // The exact expiry instant counts as expired on both sides, or the UI offers a Revoke button
  // for a link the server would already refuse.
  it('treats the expiry instant itself as expired', () => {
    expect(inviteStatus(invite({ expiresAt: NOW.toISOString() }), NOW)).toBe('expired');
    expect(
      inviteStatus(invite({ expiresAt: new Date(NOW.getTime() + 1).toISOString() }), NOW),
    ).toBe('live');
  });
});

describe('isRevocable', () => {
  it('is true only while the invite is live', () => {
    expect(isRevocable('live')).toBe(true);
    for (const s of ['revoked', 'consumed', 'expired'] as const) {
      expect(isRevocable(s), s).toBe(false);
    }
  });
});
