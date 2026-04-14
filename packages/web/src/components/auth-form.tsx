'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, type ApiError, type User } from '@/lib/api-client';
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
  mode: 'login' | 'register';
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isLogin = mode === 'login';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api.post<{ user: User }>(`/auth/${mode}`, { email, password });
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
        <CardTitle>{isLogin ? 'Sign in to Haive' : 'Create your Haive account'}</CardTitle>
        <CardDescription>
          {isLogin
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
        <FormError message={error} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Working...' : isLogin ? 'Sign in' : 'Create account'}
        </Button>
      </form>
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
    </Card>
  );
}
