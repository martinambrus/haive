import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { ForcedPasswordGuard } from '@/components/forced-password-guard';
import { SidebarNav } from '@/components/sidebar-nav';
import { GlobalPauseBanner } from '@/components/global-pause-banner';
import { MaintenanceNotice } from '@/components/maintenance-notice';
import { StaleBuildBanner } from '@/components/stale-build-banner';
import { CliLoginProvider } from '@/components/cli-login-provider';
import { NotificationProvider } from '@/components/notifications/notification-provider';
import { SessionKeepAlive } from '@/components/session-keepalive';

interface MeResponse {
  user: {
    id: string;
    email: string;
    role: 'admin' | 'user';
    status: 'active' | 'deactivated';
    /** Optional: an api that predates the column omits it, and the guard must fail open. */
    mustChangePassword?: boolean;
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
  // `?session=expired`, not a bare `/login`: this layout has just asked the api and been refused,
  // but the browser still HOLDS the cookies. Without the marker the middleware reads their presence
  // as a session and sends the visitor back to /dashboard, which lands here again — an infinite
  // redirect on exactly the state a user cannot fix themselves. The marker tells it to clear them.
  if (!data) redirect('/login?session=expired');

  // A password an administrator minted is a shared secret until its holder replaces it. Read from
  // the /auth/me call above, so the guard below costs no extra request.
  const mustChangePassword = data.user.mustChangePassword ?? false;

  return (
    <CliLoginProvider>
      <div className="flex min-h-screen">
        <SidebarNav email={data.user.email} role={data.user.role} />
        <main className="flex-1 overflow-y-auto p-8">
          {/* Renders nothing unless the admin global pause switch is on. Role comes from the
              /auth/me call this layout already makes, so the banner costs no extra request
              to decide whether to offer the admin link. */}
          {/* Renders nothing until the server's code stamp moves past the one this page loaded
              with, so it is silent on a page that was just opened. FIRST in the column because
              its bar is fixed and its spacer is what keeps everything below it — the pause
              banner included — out from under that bar. */}
          <StaleBuildBanner />
          {/* Without this the guard below is unexplained: the user asked for one page and
              landed on another. */}
          {mustChangePassword && (
            <div
              role="status"
              className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
            >
              <KeyRound className="h-5 w-5 shrink-0 text-amber-400" />
              <span className="font-semibold">Choose a new password to continue.</span>
              <span className="text-amber-200/80">
                Your current password was set for you by an administrator, so someone else has seen
                it. The rest of Haive is available again once you have replaced it.
              </span>
            </div>
          )}
          <GlobalPauseBanner role={data.user.role} />
          {/* Wraps rather than sits beside the others: under full maintenance a non-admin's
              requests are being refused, so their page is REPLACED with an explanation instead
              of left to fail every fetch behind a banner. Draining renders as a banner. */}
          <MaintenanceNotice role={data.user.role}>
            <ForcedPasswordGuard mustChangePassword={mustChangePassword}>
              {children}
            </ForcedPasswordGuard>
          </MaintenanceNotice>
        </main>
      </div>
      <NotificationProvider />
      <SessionKeepAlive />
    </CliLoginProvider>
  );
}
