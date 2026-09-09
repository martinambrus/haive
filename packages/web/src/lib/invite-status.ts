/**
 * What an invitation currently IS, from the three timestamps the api reports.
 *
 * The row carries `revokedAt`, `consumedAt` and `expiresAt` as separate facts precisely because a
 * row can hold more than one at once — the migration's own header says so. Rendering them
 * independently would show one invite as both used and expired, so the order here is the one the
 * server's `checkInvite` already uses: the most DELIBERATE reason first, time last.
 */
export type InviteStatus = 'revoked' | 'consumed' | 'expired' | 'live';

export interface InviteTimestamps {
  revokedAt: string | null;
  consumedAt: string | null;
  expiresAt: string;
}

export function inviteStatus(invite: InviteTimestamps, now: Date = new Date()): InviteStatus {
  if (invite.revokedAt) return 'revoked';
  if (invite.consumedAt) return 'consumed';
  // `<=`, matching checkInvite: the expiry instant itself is expired, so the UI never offers a
  // Revoke button for a link the server would already refuse.
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'live';
}

/** Only a live invite can be revoked — every other state is already final. */
export function isRevocable(status: InviteStatus): boolean {
  return status === 'live';
}

export function inviteStatusVariant(status: InviteStatus): 'success' | 'warning' | 'default' {
  if (status === 'live') return 'success';
  if (status === 'revoked') return 'warning';
  return 'default';
}
