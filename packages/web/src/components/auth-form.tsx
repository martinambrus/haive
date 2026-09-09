'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, type ApiError, type RegistrationStatus, type User } from '@/lib/api-client';
import {
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  FormError,
} from '@/components/ui';

interface AuthFormProps {
  /** `setup` is the FIRST account on a fresh install. It posts to the same `/auth/register`
   *  endpoint — the api decides admin-ness from the user count, not from which page asked — and
   *  differs only in its copy and in offering the setup-token field. */
  mode: 'login' | 'register' | 'setup';
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<RegistrationStatus | null>(null);

  const isLogin = mode === 'login';
  const isSetup = mode === 'setup';

  // Keep the three auth entry points consistent with the install's actual state, in ONE place
  // rather than in each page. An install with no users must not offer a sign-in that cannot
  // succeed, and one that is already set up must not offer to create a second "first" admin.
  //
  // The form renders immediately rather than waiting on this: an install WITH users is the common
  // case and redirects nowhere, so blocking on the fetch would give everyone a blank card to avoid
  // a one-time flash on a fresh install.
  useEffect(() => {
    let cancelled = false;
    api
      .get<RegistrationStatus>('/auth/registration-status')
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.setupNeeded && !isSetup) router.replace('/setup');
        if (!s.setupNeeded && isSetup) router.replace('/login');
      })
      // An unreachable API is the login page's own problem to report on submit; a failed status
      // probe must not strand the user on a blank page.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isSetup, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const endpoint = isLogin ? 'login' : 'register';
      await api.post<{ user: User }>(`/auth/${endpoint}`, {
        email,
        password,
        ...(isSetup && setupToken ? { setupToken } : {}),
      });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message ?? 'Something went wrong');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>
          {isSetup ? 'Set up Haive' : isLogin ? 'Sign in to Haive' : 'Create your Haive account'}
        </CardTitle>
        <CardDescription>
          {isSetup
            ? 'This install has no accounts yet, so the one you create now is the administrator. Pick an email and a long password (12+ characters).'
            : isLogin
              ? 'Enter your credentials to continue'
              : 'Pick an email and a long password (12+ characters)'}
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            required
            minLength={isLogin ? undefined : 12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {/* Only when the api says this install demands one. Asking unconditionally would invite
            every operator to hunt for a token that most installs never set. */}
        {isSetup && status?.setupTokenRequired && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setupToken">Setup token</Label>
            <Input
              id="setupToken"
              name="setupToken"
              type="password"
              autoComplete="off"
              required
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
            />
            <p className="text-xs text-neutral-500">
              This install sets <code>SETUP_TOKEN</code>. Find it in the <code>.env</code> beside
              its <code>docker-compose.yml</code>.
            </p>
          </div>
        )}
        <FormError message={error} />
        <Button type="submit" disabled={pending}>
          {pending
            ? 'Working...'
            : isSetup
              ? 'Create administrator account'
              : isLogin
                ? 'Sign in'
                : 'Create account'}
        </Button>
      </form>
      {/* No footer link during setup: there is nothing to sign in to yet, and offering "create an
          account" beside a form that creates the account reads as two different things. */}
      {!isSetup && (
        <p className="mt-4 text-center text-sm text-neutral-400">
          {isLogin ? (
            <>
              New here?{' '}
              <Link href="/register" className="text-indigo-400 hover:underline">
                Create an account
              </Link>
            </>
          ) : (
            <>
              Already registered?{' '}
              <Link href="/login" className="text-indigo-400 hover:underline">
                Sign in
              </Link>
            </>
          )}
        </p>
      )}
    </Card>
  );
}
