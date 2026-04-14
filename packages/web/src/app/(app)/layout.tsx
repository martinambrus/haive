import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SidebarNav } from '@/components/sidebar-nav';

interface MeResponse {
  user: {
    id: string;
    email: string;
    role: 'admin' | 'user';
    status: 'active' | 'deactivated';
    createdAt: string;
  };
}

async function fetchMe(): Promise<MeResponse | null> {
  const apiBase =
    process.env.API_URL_INTERNAL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  try {
    const res = await fetch(`${apiBase}/auth/me`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as MeResponse;
  } catch {
    return null;
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const data = await fetchMe();
  if (!data) redirect('/login');

  return (
    <div className="flex min-h-screen">
      <SidebarNav email={data.user.email} role={data.user.role} />
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
