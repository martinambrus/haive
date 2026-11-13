'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import { Button, Input, Label, Card, CardHeader, CardTitle, FormError } from '@/components/ui';
import { MarkdownView } from '@/components/markdown/markdown-view';

export function PasswordRecoveryForm({
  mode,
  token = '',
}: {
  mode: 'forgot' | 'reset';
  token?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forgot = mode === 'forgot';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      if (forgot) {
        await api.post('/auth/forgot-password', { email: String(fields.get('email') ?? '') });
        setSent(true);
      } else {
        await api.post('/auth/reset-password', {
          token,
          newPassword: String(fields.get('newPassword') ?? ''),
        });
        router.replace('/login?reset=success');
      }
    } catch (error) {
      setError((error as Error).message ?? 'The request could not be completed. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{forgot ? 'Forgot your password?' : 'Reset your password'}</CardTitle>
      </CardHeader>
      <MarkdownView
        body={
          sent
            ? 'If an account can be recovered, a reset link will be emailed. Check your inbox. The link expires in 30 minutes; a new request made more than two minutes later replaces it.'
            : forgot
              ? 'Enter your email to request a password reset link.'
              : token
                ? 'Choose a new password of at least 12 characters.'
                : 'This reset link is missing its token. Request a new reset link.'
        }
      />
      {!sent && (forgot || token) && (
        <form method="post" onSubmit={submit} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={forgot ? 'email' : 'newPassword'}>
              {forgot ? 'Email' : 'New password'}
            </Label>
            {forgot ? (
              <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
            ) : (
              <Input
                id="newPassword"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={255}
                required
                autoFocus
              />
            )}
          </div>
          <FormError message={error} />
          <Button type="submit" disabled={pending}>
            {pending ? 'Working...' : forgot ? 'Send reset link' : 'Reset password'}
          </Button>
        </form>
      )}
      {!forgot && (
        <Link
          href="/forgot-password"
          className="mt-4 block text-sm text-indigo-400 hover:underline"
        >
          Request a new reset link
        </Link>
      )}
      <Link href="/login" className="mt-4 block text-sm text-indigo-400 hover:underline">
        Back to sign in
      </Link>
    </Card>
  );
}
