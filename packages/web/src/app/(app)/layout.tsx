import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { ForcedPasswordGuard } from '@/components/forced-password-guard';
import { SidebarNav } from '@/components/sidebar-nav';
import {
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_WIDTH_VAR,
  clampSidebarWidth,
  sidebarOffsetPx,
} from '@/lib/sidebar-geometry';
import { normalizeSidebarTree } from '@/lib/sidebar-tree';
import { isTaskToneFilter } from '@/lib/task-tone';
import { GlobalPauseBanner } from '@/components/global-pause-banner';
import { MaintenanceNotice } from '@/components/maintenance-notice';
import { StaleBuildBanner } from '@/components/stale-build-banner';
import { CliLoginProvider } from '@/components/cli-login-provider';
import { NotificationProvider } from '@/components/notifications/notification-provider';
import { SessionKeepAlive } from '@/components/session-keepalive';

/** Only the keys this layout reads. The blob is schemaless on the server and web owns the
 *  keys, so the rest is passed through untouched by anything here. */
interface UiPrefsBlob {
  sidebarWidthPx?: number;
  sidebarCollapsed?: boolean;
  sidebarTree?: unknown;
  sidebarFilters?: unknown;
}

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

function apiBaseUrl(): string {
  return process.env.API_URL_INTERNAL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

/** The session, plus the cookie header it actually WORKED with — which is not always the one
 *  the browser sent, because an expired access token is refreshed here and the replacement
 *  only exists in this function. Anything else this layout wants to read server-side has to
 *  be asked for with that header or it gets a 401 the visitor cannot see. */
async function fetchMe(): Promise<{ data: MeResponse; cookie: string } | null> {
  const apiBase = apiBaseUrl();
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
    if (result) return { data: result, cookie: cookieHeader };

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
    const retried = await doFetch(newCookieHeader);
    return retried ? { data: retried, cookie: newCookieHeader } : null;
  } catch {
    return null;
  }
}

/** The sidebar's own width, collapsed flag and folder arrangement, read HERE rather than by
 *  the client component that owns them: it is server-rendered, so fetching them in the
 *  browser would paint the default column and jump. Any failure falls back to the defaults
 *  and never blocks the page — the sidebar is a chrome, not a gate. */
async function fetchSidebarPrefs(cookie: string): Promise<UiPrefsBlob> {
  try {
    const res = await fetch(`${apiBaseUrl()}/user-settings/ui-prefs`, {
      headers: { Cookie: cookie },
      cache: 'no-store',
    });
    if (!res.ok) return {};
    const body = (await res.json()) as { settingsJson?: string };
    const parsed: unknown = JSON.parse(body.settingsJson ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as UiPrefsBlob)
      : {};
  } catch {
    return {};
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await fetchMe();
  // `?session=expired`, not a bare `/login`: this layout has just asked the api and been refused,
  // but the browser still HOLDS the cookies. Without the marker the middleware reads their presence
  // as a session and sends the visitor back to /dashboard, which lands here again — an infinite
  // redirect on exactly the state a user cannot fix themselves. The marker tells it to clear them.
  if (!session) redirect('/login?session=expired');
  const data = session.data;

  const prefs = await fetchSidebarPrefs(session.cookie);

  // A password an administrator minted is a shared secret until its holder replaces it. Read from
  // the /auth/me call above, so the guard below costs no extra request.
  const mustChangePassword = data.user.mustChangePassword ?? false;

  return (
    <CliLoginProvider>
      {/* Carries the sidebar's live width to the `position: fixed` bars inside <main>,
          which are outside the flex row and can see it no other way. Seeded here so it is
          right on the first paint; SidebarNav rewrites it on this same element as the
          column is dragged or collapsed. */}
      <div
        className="flex min-h-screen"
        style={
          {
            [SIDEBAR_WIDTH_VAR]: `${sidebarOffsetPx(
              prefs.sidebarCollapsed === true,
              clampSidebarWidth(prefs.sidebarWidthPx ?? SIDEBAR_DEFAULT_PX),
            )}px`,
          } as React.CSSProperties
        }
      >
        <SidebarNav
          email={data.user.email}
          role={data.user.role}
          initialWidthPx={clampSidebarWidth(prefs.sidebarWidthPx ?? SIDEBAR_DEFAULT_PX)}
          initialCollapsed={prefs.sidebarCollapsed === true}
          initialTree={normalizeSidebarTree(prefs.sidebarTree)}
          initialFilters={
            Array.isArray(prefs.sidebarFilters) ? prefs.sidebarFilters.filter(isTaskToneFilter) : []
          }
        />
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
