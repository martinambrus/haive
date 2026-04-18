import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SidebarNav } from '@/components/sidebar-nav';
import { CliLoginProvider } from '@/components/cli-login-provider';

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

  const doFetch = async (cookie: string) => {
    const res = await fetch(`${apiBase}/auth/me`, {
      headers: { Cookie: cookie },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as MeResponse;
  };

  try {
    const result = await doFetch(cookieHeader);
    if (result) return result;

    // Access token may be expired — try server-side refresh
    const hasRefresh = cookieStore.get('haive_refresh');
    if (!hasRefresh) return null;

    const refreshRes = await fetch(`${apiBase}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    if (!refreshRes.ok) return null;

    // Extract new cookies from refresh response and retry /auth/me
    const setCookies = refreshRes.headers.getSetCookie();
    const newCookieHeader = setCookies
      .map((sc) => sc.split(';')[0]!)
      .concat(cookieHeader.split('; ').filter((c) => !c.startsWith('haive_')))
      .join('; ');
    return await doFetch(newCookieHeader);
  } catch {
    return null;
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const data = await fetchMe();
  if (!data) redirect('/login');

  return (
    <CliLoginProvider>
      <div className="flex min-h-screen">
        <SidebarNav email={data.user.email} role={data.user.role} />
        <main className="flex-1 overflow-y-auto p-8">{children}</main>
      </div>
    </CliLoginProvider>
  );
}
