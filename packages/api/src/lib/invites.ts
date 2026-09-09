import { createHash, randomBytes } from 'node:crypto';

/**
 * Invite tokens, and whether one may be redeemed.
 *
 * The validity rules are a pure function for the same reason `decideRegistration` is: this decides
 * who gets an account, `packages/api` has no HTTP-level auth tests, and the four ways an invite can
 * be invalid are exactly the cases worth pinning down. The route supplies the row and applies the
 * answer inside the registration transaction.
 */

/** 32 bytes of base64url — 256 bits, URL-safe so it can be pasted into a link without escaping. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Stored form. Same sha256 shape as `hashRefreshToken`, so the raw token exists only in the
 *  response that created it and in whatever the admin pastes to the invitee. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The columns the decision needs. Deliberately not the whole row — a pure function that took the
 *  Drizzle row would drag the schema into every test. */
export interface InviteRow {
  role: 'admin' | 'user';
  emailBlindIndex: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  consumedAt: Date | null;
}

export type InviteRefusal = 'unknown' | 'revoked' | 'consumed' | 'expired' | 'wrong-email';

export type InviteVerdict =
  | { valid: true; role: 'admin' | 'user' }
  | { valid: false; refusal: InviteRefusal; message: string };

/** Every refusal says the same thing to the caller.
 *
 *  Distinguishing "already used" from "never existed" tells someone probing tokens which guesses
 *  were once real, and none of the four is actionable by the person holding a bad link — the
 *  remedy is always to ask for another. The specific `refusal` is kept for the server's own log. */
const REFUSAL_MESSAGE = 'That invitation is not valid. Ask an administrator for a new one.';

export function checkInvite(
  invite: InviteRow | null | undefined,
  candidateEmailBlindIndex: string,
  now: Date = new Date(),
): InviteVerdict {
  if (!invite) return { valid: false, refusal: 'unknown', message: REFUSAL_MESSAGE };
  if (invite.revokedAt) return { valid: false, refusal: 'revoked', message: REFUSAL_MESSAGE };
  if (invite.consumedAt) return { valid: false, refusal: 'consumed', message: REFUSAL_MESSAGE };
  if (invite.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, refusal: 'expired', message: REFUSAL_MESSAGE };
  }
  // A null blind index is a generic link and matches anyone; a bound invite matches one address.
  if (invite.emailBlindIndex && invite.emailBlindIndex !== candidateEmailBlindIndex) {
    return { valid: false, refusal: 'wrong-email', message: REFUSAL_MESSAGE };
  }
  return { valid: true, role: invite.role };
}
