import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth-form';
import { fetchRegistrationStatus } from '@/lib/registration-status.server';

export const metadata: Metadata = { title: 'Sign in' };

// Never prerendered: a status baked in at build time would be whatever the builder's api said —
// or null, if there was no api — which is exactly the stale first paint this prop exists to fix.
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  return <AuthForm mode="login" initialStatus={await fetchRegistrationStatus()} />;
}
