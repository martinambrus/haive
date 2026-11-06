/** Same version syntax accepted by the upgrade API. The journal column is NOT NULL. */
export function attemptVersion(version: string | undefined): string {
  return version && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version) ? version : 'unknown';
}
