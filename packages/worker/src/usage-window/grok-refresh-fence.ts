import { createHash } from 'node:crypto';

/** Written before a single-use grant, so a lost response/write cannot silently admit
 * the credential it may have consumed. A new login has a different refresh token. */
export const GROK_REFRESH_FENCE_FILE = '.haive-grok-refresh';

export function grokRefreshFingerprint(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}
