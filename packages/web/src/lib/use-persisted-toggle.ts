'use client';

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/** A boolean toggle (collapsed/expanded, shown/hidden) whose state is persisted to
 *  localStorage under `key`, so it survives reloads and revisits to the same task.
 *
 *  Returns `[value, setPersistent, setEphemeral]`:
 *  - `setPersistent` updates state AND writes localStorage. Use it for an explicit
 *    user action (clicking the toggle) — the only intent worth remembering.
 *  - `setEphemeral` updates state only, no write. Use it for programmatic, transient
 *    changes (auto-open while running / auto-collapse when idle). These MUST NOT
 *    persist: a persisted programmatic collapse leaves a stale '0' that then wins on
 *    the next mount-while-running — e.g. a retried step's terminal unmounts (its
 *    cli_invocations are superseded → count 0) and remounts already running, where
 *    the open-on-running transition can't fire (no transition at mount), so the
 *    running terminal would stay hidden behind the stale '0'.
 *
 *  - `key === null` disables persistence (pure in-memory) — for callers without a
 *    stable id yet. Both setters then behave identically (in-memory only).
 *  - The initial value is read synchronously in the initializer (window-guarded), so
 *    a restored state never flashes the fallback first. Safe because callers render
 *    client-side only (no SSR of the element → no hydration mismatch).
 *  - Nothing is written until `setPersistent` is called: an absent key means "no
 *    explicit user choice yet" → the caller's live `fallback` is used on every mount.
 *    So a value is stored only when the user actually toggled it. */
export function usePersistedToggle(
  key: string | null,
  fallback: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState<boolean>(() => {
    if (key === null || typeof window === 'undefined') return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      return raw === '1' ? true : raw === '0' ? false : fallback;
    } catch {
      return fallback;
    }
  });

  // Explicit user action: resolve the next value, persist it, then commit. The
  // write lives inside the updater so the functional form (v => !v) sees the latest
  // value; it is idempotent (same key+value), so a StrictMode double-invoke is a
  // harmless repeat write.
  const setPersistent = useCallback<Dispatch<SetStateAction<boolean>>>(
    (next) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next;
        if (key !== null && typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(key, resolved ? '1' : '0');
          } catch {
            // private-mode quota etc. — keep the in-memory value.
          }
        }
        return resolved;
      });
    },
    [key],
  );

  // setValue is the raw, non-persisting dispatcher (stable identity across renders).
  return [value, setPersistent, setValue];
}
