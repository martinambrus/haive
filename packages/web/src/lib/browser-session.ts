/** Rotation belongs to the browser: only it can install the API's HttpOnly cookies. */
export type SessionRecoveryResult = 'authenticated' | 'rejected' | 'unavailable';

async function recover(apiBase: string, rotate: boolean): Promise<SessionRecoveryResult> {
  const me = () =>
    fetch(`${apiBase}/auth/me`, {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  if (!rotate) {
    const current = await me();
    if (current.ok) return 'authenticated';
    if (current.status !== 401) return 'unavailable';
  }
  const response = await fetch(`${apiBase}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.ok) return 'authenticated';
  if (response.status !== 401) return 'unavailable';
  // Re-read the jar, never the request's snapshot. Also covers a rotation from a page loaded
  // before this coordinator existed. A refusal carries no Set-Cookie, so cannot undo a winner.
  const current = await me();
  if (current.ok) return 'authenticated';
  return current.status === 401 ? 'rejected' : 'unavailable';
}

/** All browser callers (including keepalive and the recovery shell) share this origin-wide lock.
 * Hold it through response headers: the database winner may have committed while its replacement
 * cookies are still in flight. A same-tab promise alone does not cover parallel tabs/navigations. */
export async function recoverBrowserSession(
  apiBase: string,
  rotate = false,
): Promise<SessionRecoveryResult> {
  try {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return await navigator.locks.request(
        'haive:session-rotation',
        {
          signal: AbortSignal.timeout(20_000),
        },
        () => recover(apiBase, rotate),
      );
    }
    const result = await recover(apiBase, rotate);
    // Without Web Locks (e.g. plain HTTP outside localhost), a 401 could precede another tab's
    // late success. Keep the retry screen instead of claiming the shared session was revoked.
    return result === 'rejected' ? 'unavailable' : result;
  } catch {
    return 'unavailable';
  }
}
