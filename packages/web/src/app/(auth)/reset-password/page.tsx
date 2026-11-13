import type { Metadata } from 'next';
import { PasswordRecoveryForm } from '@/components/password-recovery-form';

export const metadata: Metadata = { title: 'Reset password', referrer: 'no-referrer' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <PasswordRecoveryForm mode="reset" token={typeof token === 'string' ? token : ''} />;
}
