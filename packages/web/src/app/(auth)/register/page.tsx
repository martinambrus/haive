import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth-form';
import { fetchRegistrationStatus } from '@/lib/registration-status.server';

export const metadata: Metadata = { title: 'Create account' };

// Never prerendered: a status baked in at build time would be whatever the builder's api said —
// or null, if there was no api — which is exactly the stale first paint this prop exists to fix.
export const dynamic = 'force-dynamic';

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, status] = await Promise.all([searchParams, fetchRegistrationStatus()]);
  // Read HERE rather than from `window.location` in an effect. Whether an invitation is present
  // decides whether the form renders at all, so learning it one paint late means an invitee is
  // told registration is closed and then told it is not — MEASURED at 5ms to 271ms.
  const invite = params.invite;
  return (
    <AuthForm
      mode="register"
      initialStatus={status}
      initialInviteToken={typeof invite === 'string' ? invite : null}
    />
  );
}
