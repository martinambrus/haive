'use client';

import Link from 'next/link';
import { PauseCircle } from 'lucide-react';
import { useGlobalPause } from '@/lib/use-global-pause';

/**
 * App-wide banner for the admin global pause switch. Renders nothing while the switch is off,
 * so every page can mount it unconditionally.
 *
 * Reads `/system/pause` rather than the admin config route: that one is admin-gated and this
 * banner has to reach every user — without it a non-admin sees tasks that simply stop
 * progressing, with nothing anywhere saying why.
 *
 * Deliberately NOT `position: fixed`. The task-details page owns a fixed title strip at the top
 * of the viewport, which would render straight over a fixed banner; scrolling with the content
 * keeps both readable.
 */
export function GlobalPauseBanner({ role }: { role: 'admin' | 'user' }) {
  // Polling lives in lib/use-global-pause so this banner and the step/terminal copy that also
  // depends on the switch cannot drift apart or double up on requests.
  const paused = useGlobalPause();

  if (!paused) return null;

  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      <PauseCircle className="h-5 w-5 shrink-0 text-amber-400" />
      <span className="font-semibold">All task execution is paused.</span>
      <span className="text-amber-200/80">
        No step advances and no new CLI run starts. Runs already in flight finish normally, and
        terminals, the editor, the browser and app environments keep working.
      </span>
      {role === 'admin' && (
        <Link href="/admin" className="font-semibold text-amber-100 underline">
          Resume in admin settings
        </Link>
      )}
    </div>
  );
}
