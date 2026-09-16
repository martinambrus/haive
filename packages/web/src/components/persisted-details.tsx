'use client';

import { useState, type ReactNode } from 'react';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';

/** A `<details>` disclosure whose open/closed state is persisted per `persistKey`
 *  (via usePersistedToggle), so it survives reloads and revisits to the same task.
 *
 *  Controlled via `open` + `onToggle`: the native toggle drives the state, the state
 *  drives the attribute — unlike a bare `<details open={defaultOpen}>`, which is
 *  uncontrolled and resets to its default on every remount/reload.
 *
 *  `persistKey === null` → in-memory only (caller has no stable id yet); the toggle
 *  still works for the session but is not remembered. */
export function PersistedDetails({
  persistKey,
  defaultOpen = false,
  lazy = false,
  className,
  summaryClassName,
  summary,
  children,
}: {
  persistKey: string | null;
  defaultOpen?: boolean;
  /** Mount `children` only once the disclosure has been opened, and keep them mounted after:
   *  a body that fetches on mount then costs nothing while closed and does not refetch on
   *  every toggle. */
  lazy?: boolean;
  className?: string;
  summaryClassName?: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistedToggle(persistKey, defaultOpen);
  const [everOpened, setEverOpened] = useState(open);
  if (open && !everOpened) setEverOpened(true);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className={className}>
      <summary className={summaryClassName}>{summary}</summary>
      {lazy && !everOpened ? null : children}
    </details>
  );
}
