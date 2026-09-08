'use client';

import Link from 'next/link';
import { Wrench } from 'lucide-react';
import { useMaintenanceState } from '@/lib/use-global-pause';

/**
 * The two visible halves of a maintenance window.
 *
 * `draining` is a BANNER over a working app: new tasks are refused but everything already
 * running continues, and a user who is mid-flow needs to know why the New Task button just
 * started failing without being thrown out of what they are doing.
 *
 * `maintenance` REPLACES the page for a non-admin, because their requests are being refused —
 * leaving them on a normal-looking app that fails every fetch is the worse outcome, and the one
 * this exists to prevent. Admins are never locked out or someone would have to lift maintenance
 * from a shell.
 *
 * The state comes from the shared `/system/state` poller, which stays reachable during
 * maintenance precisely so a locked-out user can be told rather than left guessing.
 */
export function MaintenanceNotice({
  role,
  children,
}: {
  role: 'admin' | 'user';
  children: React.ReactNode;
}) {
  const state = useMaintenanceState();

  if (state === 'maintenance' && role !== 'admin') {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <Wrench className="mb-4 h-10 w-10 text-amber-400" />
        <h1 className="text-xl font-semibold text-neutral-100">Haive is being upgraded</h1>
        <p className="mt-2 max-w-md text-sm text-neutral-400">
          The system is temporarily unavailable while an upgrade completes. Your tasks and their
          history are untouched — this page will let you back in as soon as it finishes.
        </p>
      </div>
    );
  }

  return (
    <>
      {state !== 'normal' && (
        <div
          role="status"
          className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          <Wrench className="h-5 w-5 shrink-0 text-amber-400" />
          <span className="font-semibold">
            {state === 'draining'
              ? 'Haive is preparing for maintenance.'
              : 'Haive is in maintenance.'}
          </span>
          <span className="text-amber-200/80">
            New tasks cannot be started. Work already running will finish normally.
          </span>
          {role === 'admin' && (
            <Link href="/admin" className="font-semibold text-amber-100 underline">
              Manage in admin settings
            </Link>
          )}
        </div>
      )}
      {children}
    </>
  );
}
