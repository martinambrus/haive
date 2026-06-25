'use client';

import type { ReactNode } from 'react';
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
  className,
  summaryClassName,
  summary,
  children,
}: {
  persistKey: string | null;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistedToggle(persistKey, defaultOpen);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className={className}>
      <summary className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  );
}
