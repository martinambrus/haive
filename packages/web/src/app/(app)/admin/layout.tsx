'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { TabNav } from '@/components/tabs';
import { Button, Card, CardDescription, CardHeader, CardTitle, FormError } from '@/components/ui';

const ADMIN_TABS = [
  { label: 'Settings', href: '/admin' },
  { label: 'Users', href: '/admin/users' },
  { label: 'Pricing', href: '/admin/pricing' },
  { label: 'Maintenance', href: '/admin/maintenance' },
  { label: 'Audit log', href: '/admin/audit' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Longest match, not a prefix test: '/admin' prefixes every sub-page, so a prefix rule would
  // light Settings on all five.
  const active =
    ADMIN_TABS.map((t) => t.href)
      .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
      .sort((a, b) => b.length - a.length)[0] ?? '/admin';

  const [globalPause, setGlobalPause] = useState<boolean | null>(null);
  const [savingGlobalPause, setSavingGlobalPause] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGlobalPause = useCallback(async () => {
    try {
      const data = await api.get<{ paused: boolean }>('/admin/config/global-pause');
      setGlobalPause(data.paused);
    } catch {
      // A read that fails leaves the card unrendered rather than claiming a state. The pages
      // below own their own errors; a layout that hijacked the view would hide them.
    }
  }, []);

  useEffect(() => {
    void loadGlobalPause();
  }, [loadGlobalPause]);

  async function setGlobalPauseSwitch(next: boolean) {
    setSavingGlobalPause(true);
    try {
      const result = await api.put<{ paused: boolean }>('/admin/config/global-pause', {
        paused: next,
      });
      setGlobalPause(result.paused);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update the global pause switch');
    } finally {
      setSavingGlobalPause(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">Admin console</h1>
        <p className="text-sm text-neutral-400">
          System settings, users and health for this instance. Requires an admin role.
        </p>
      </div>

      {/* Global pause. It lives in the LAYOUT, above the tabs, so it is reachable from every
          admin page rather than only from the settings tab — an emergency switch you have to
          navigate to is one you have to remember where you left. It is also the only control
          rendered as a button rather than a checkbox: it is the one switch that changes what the
          whole system is doing right now, and it has to be obvious both to reach and to notice
          when it is on. */}
      {globalPause !== null && (
        <Card
          className={
            globalPause ? 'border-amber-500/60 bg-amber-500/10' : 'border-red-900/60 bg-red-950/20'
          }
        >
          <CardHeader>
            <CardTitle className={globalPause ? 'text-amber-200' : undefined}>
              {globalPause ? 'ALL EXECUTION PAUSED' : 'Global pause'}
            </CardTitle>
            <CardDescription>
              {globalPause
                ? 'No task is being advanced and no queued CLI run is being picked up. Runs that were already in flight finish normally.'
                : 'Freeze every task at once without cancelling anything. The CLI run in flight finishes, then no step advances and no queued CLI run starts anywhere.'}{' '}
              Terminals, the editor, the browser and the app environments keep working either way,
              so a frozen system stays debuggable. Takes effect within ~30 seconds and persists
              across restarts.
            </CardDescription>
          </CardHeader>
          <FormError message={error} />
          <Button
            variant={globalPause ? 'primary' : 'destructive'}
            disabled={savingGlobalPause}
            onClick={() => void setGlobalPauseSwitch(!globalPause)}
            className="mt-2 w-full py-3 text-base font-semibold sm:w-auto sm:px-8"
          >
            {savingGlobalPause
              ? 'Saving…'
              : globalPause
                ? 'Resume all execution'
                : 'Pause all execution'}
          </Button>
        </Card>
      )}

      <TabNav items={ADMIN_TABS} active={active} />
      {children}
    </div>
  );
}
