'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/** A boolean toggle (collapsed/expanded, shown/hidden) whose state is persisted to
 *  localStorage under `key`, so it survives reloads and revisits to the same task.
 *
 *  - `key === null` disables persistence (pure in-memory) — for callers without a
 *    stable id yet.
 *  - The initial value is read synchronously in the initializer (window-guarded), so
 *    a restored state never flashes the fallback first. Safe because callers render
 *    client-side only (no SSR of the element → no hydration mismatch).
 *  - Storage errors (private-mode quota) are swallowed and the value stays in memory.
 *
 *  Callers keep their own auto-behavior (e.g. expand-while-running): pass the current
 *  auto value as `fallback`; it is only used when nothing is stored yet. A stored
 *  value always wins on mount, so auto-transitions must guard against firing on mount
 *  (see StepTerminal's prevAutoExpand ref) to avoid clobbering a restored state. */
export function usePersistedToggle(
  key: string | null,
  fallback: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState<boolean>(() => {
    if (key === null || typeof window === 'undefined') return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      return raw === '1' ? true : raw === '0' ? false : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    if (key === null || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, value ? '1' : '0');
    } catch {
      // private-mode quota etc. — keep the in-memory value.
    }
  }, [key, value]);

  return [value, setValue];
}
