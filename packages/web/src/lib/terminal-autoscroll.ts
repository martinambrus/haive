'use client';

import { useCallback, useEffect, useState } from 'react';

// User preference: auto-scroll the page to the newest CLI run terminal as it
// appears on a step. Persisted in a cookie so it survives reloads, shared by
// every step's terminal. Default ON.
const COOKIE = 'haive_term_autoscroll';
const CHANGE_EVENT = 'haive-term-autoscroll-change';

/** Read the preference from the cookie. Defaults to ON when unset. Safe to call
 *  on the server (returns true) so the page-level scroll effect can gate on it. */
export function autoScrollTerminalsEnabled(): boolean {
  if (typeof document === 'undefined') return true;
  const m = document.cookie.match(/(?:^|;\s*)haive_term_autoscroll=([01])/);
  return m ? m[1] === '1' : true;
}

function writePref(value: boolean): void {
  // Site-wide, 1-year cookie.
  document.cookie = `${COOKIE}=${value ? '1' : '0'}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

/** Cookie-backed [enabled, setEnabled]. Initialised to ON on the server and
 *  re-read from the cookie after mount (avoids a hydration mismatch). Toggling
 *  fires a window event so every terminal's checkbox stays in sync. */
export function useAutoScrollTerminals(): [boolean, (value: boolean) => void] {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    setEnabled(autoScrollTerminalsEnabled());
    const onChange = (): void => setEnabled(autoScrollTerminalsEnabled());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  const set = useCallback((value: boolean): void => {
    writePref(value);
    setEnabled(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [enabled, set];
}
