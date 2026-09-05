'use client';

import { useCallback, useEffect, useState } from 'react';

// User preference: collapse a run's terminal as soon as it exits 0, instead of keeping
// it mounted because the user watched it run (the `seenActive` exception in
// isInvocationExpanded). Running, queued and FAILED runs are left alone — a failure is
// the output the user still needs. Default OFF, so the watched-it-finish behaviour is
// what an untouched install keeps.
//
// Cookie plus a window event rather than usePersistedToggle, for the same reason the
// auto-scroll preference is: one StepTerminal renders per step, so a task page shows many
// checkboxes for the one preference, and a localStorage-only toggle would leave the
// siblings disagreeing (and still auto-closing) until they remount.
const COOKIE = 'haive_term_autoclose';
const CHANGE_EVENT = 'haive-term-autoclose-change';
const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE}=([01])`);

/** Read the preference from the cookie. Defaults to OFF when unset. Safe to call on the
 *  server (returns false). */
export function autoCloseSuccessfulTerminalsEnabled(): boolean {
  if (typeof document === 'undefined') return false;
  const m = document.cookie.match(COOKIE_RE);
  return m ? m[1] === '1' : false;
}

function writePref(value: boolean): void {
  // Site-wide, 1-year cookie.
  document.cookie = `${COOKIE}=${value ? '1' : '0'}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

/** Cookie-backed [enabled, setEnabled]. Initialised to OFF on the server and re-read from
 *  the cookie after mount (avoids a hydration mismatch). Toggling fires a window event so
 *  every step's checkbox — and every step's collapse rule — moves together. */
export function useAutoCloseSuccessfulTerminals(): [boolean, (value: boolean) => void] {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    setEnabled(autoCloseSuccessfulTerminalsEnabled());
    const onChange = (): void => setEnabled(autoCloseSuccessfulTerminalsEnabled());
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
