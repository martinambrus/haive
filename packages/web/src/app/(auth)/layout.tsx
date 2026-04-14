import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center p-6">{children}</main>;
}
