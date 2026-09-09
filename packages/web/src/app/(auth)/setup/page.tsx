import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth-form';

export const metadata: Metadata = { title: 'Set up Haive' };

/** The first-run entry point. `AuthForm` checks `/auth/registration-status` and sends the visitor
 *  to `/login` if this install already has accounts, so the page itself needs no guard. */
export default function SetupPage() {
  return <AuthForm mode="setup" />;
}
