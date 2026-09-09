import type { RegistrationStatus } from '@/lib/api-client';

/**
 * Read `/auth/registration-status` on the SERVER, so the auth pages' first paint already knows
 * whether this install accepts registrations.
 *
 * The three auth pages used to learn it only from a client fetch, which meant every one of them
 * painted the OPEN-install version first and corrected itself when the answer landed — MEASURED on
 * a `closed` install, the login page offered "Create an account" from 4ms to 236ms, and /register
 * showed the whole registration form from 3ms to 148ms before replacing it with a refusal. A form
 * a visitor can start typing into and then lose is worse than a slow one.
 *
 * Same shape as `(app)/layout.tsx`'s `/auth/me` call, including the internal URL and the swallowed
 * error: a status probe that fails must not 500 the login page, so the caller falls back to what
 * it did before this existed.
 */
export async function fetchRegistrationStatus(): Promise<RegistrationStatus | null> {
  const apiBase =
    process.env.API_URL_INTERNAL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  try {
    const res = await fetch(`${apiBase}/auth/registration-status`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as RegistrationStatus;
  } catch {
    return null;
  }
}
