import { describe, expect, it } from 'vitest';
import {
  checkInvite,
  generateInviteToken,
  hashInviteToken,
  type InviteRow,
} from '../src/lib/invites.js';

const NOW = new Date('2026-09-09T12:00:00Z');
const HOUR = 3_600_000;

function invite(over: Partial<InviteRow> = {}): InviteRow {
  return {
    role: 'user',
    emailBlindIndex: null,
    expiresAt: new Date(NOW.getTime() + HOUR),
    revokedAt: null,
    consumedAt: null,
    ...over,
  };
}

describe('tokens', () => {
  it('are long, URL-safe and unique', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    // base64url of 32 bytes: no +, / or = to escape when pasted into a link.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hash deterministically, and the hash is not the token', () => {
    const t = generateInviteToken();
    expect(hashInviteToken(t)).toBe(hashInviteToken(t));
    expect(hashInviteToken(t)).not.toBe(t);
    expect(hashInviteToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('redeeming', () => {
  it('accepts a live generic invite and carries its role', () => {
    expect(checkInvite(invite(), 'anyone', NOW)).toEqual({ valid: true, role: 'user' });
    expect(checkInvite(invite({ role: 'admin' }), 'anyone', NOW)).toEqual({
      valid: true,
      role: 'admin',
    });
  });

  it('accepts a bound invite only from the address it was bound to', () => {
    const bound = invite({ emailBlindIndex: 'blind-abc' });
    expect(checkInvite(bound, 'blind-abc', NOW)).toMatchObject({ valid: true });
    expect(checkInvite(bound, 'blind-xyz', NOW)).toMatchObject({
      valid: false,
      refusal: 'wrong-email',
    });
  });

  it('refuses a token that never existed', () => {
    expect(checkInvite(null, 'anyone', NOW)).toMatchObject({ valid: false, refusal: 'unknown' });
  });

  it('refuses a revoked invite', () => {
    expect(checkInvite(invite({ revokedAt: NOW }), 'anyone', NOW)).toMatchObject({
      valid: false,
      refusal: 'revoked',
    });
  });

  // The single-use guarantee. The route also consumes inside the registration transaction, so two
  // simultaneous redemptions cannot both pass; this is the check that makes a LATER reuse fail.
  it('refuses an invite that was already used', () => {
    expect(checkInvite(invite({ consumedAt: NOW }), 'anyone', NOW)).toMatchObject({
      valid: false,
      refusal: 'consumed',
    });
  });

  it('refuses an expired invite, and treats the exact expiry instant as expired', () => {
    expect(checkInvite(invite({ expiresAt: new Date(NOW.getTime() - 1) }), 'a', NOW)).toMatchObject(
      {
        valid: false,
        refusal: 'expired',
      },
    );
    expect(checkInvite(invite({ expiresAt: NOW }), 'a', NOW)).toMatchObject({
      valid: false,
      refusal: 'expired',
    });
  });

  // Telling a prober which guesses were once real is worth more to them than to the person holding
  // a dead link, whose remedy is the same in every case.
  it('says the same thing however it is invalid', () => {
    const messages = [
      checkInvite(null, 'a', NOW),
      checkInvite(invite({ revokedAt: NOW }), 'a', NOW),
      checkInvite(invite({ consumedAt: NOW }), 'a', NOW),
      checkInvite(invite({ expiresAt: new Date(NOW.getTime() - 1) }), 'a', NOW),
      checkInvite(invite({ emailBlindIndex: 'other' }), 'a', NOW),
    ].map((v) => (v.valid === false ? v.message : 'VALID'));
    expect(new Set(messages).size, messages.join(' | ')).toBe(1);
  });

  // Ordering: a revoked AND expired invite reports revoked. Only the log sees it, but a stable
  // answer beats one that depends on which check happens to run first.
  it('reports the most deliberate reason first', () => {
    const both = invite({ revokedAt: NOW, expiresAt: new Date(NOW.getTime() - 1) });
    expect(checkInvite(both, 'a', NOW)).toMatchObject({ refusal: 'revoked' });
  });
});
