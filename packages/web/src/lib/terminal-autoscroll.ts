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

/** Whether a change in a step's set of RUNNING terminal ids should move the view.
 *  Follows the set in BOTH directions: a run starting, and a run ending while
 *  siblings keep going. The ending case is the one users notice — without it the
 *  view stays parked on the terminal that just exited while the still-running
 *  ones scroll by unseen.
 *
 *  False on the first observation (the page-level effect owns the initial scroll)
 *  and when nothing is left running: the step is wrapping up, and the page-level
 *  effect scrolls to whatever becomes active next — scrolling to this step's list
 *  tail would fight it. */
export function shouldFollowRunningTerminals(prev: string[] | null, next: string[]): boolean {
  if (prev === null) return false;
  if (next.length === 0) return false;
  const gained = next.some((id) => !prev.includes(id));
  const lost = prev.some((id) => !next.includes(id));
  return gained || lost;
}

/** Scroll the newest RUNNING terminal inside `root` into view. Returns false when
 *  no target exists yet — run panels mount a tick after their invocation row
 *  appears, so callers retry.
 *
 *  Framing is `block: 'start'`. A run panel is ~510-550px tall inside a ~1000px
 *  viewport, so aligning its BOTTOM with the viewport bottom (what both call sites
 *  used to do) handed the top half of the screen to the PRECEDING panel — normally
 *  the run that just exited, which is what made a correct scroll look like it had
 *  landed on a finished terminal. Panels carry `scroll-mt-12` so their header row
 *  clears the fixed top bar.
 *
 *  Prefers the newest RUNNING run: the last panel (and the toggle below it) is
 *  often a queued, empty terminal — a step that fans out more invocations than the
 *  concurrency cap (03-phase-0a-discovery: 8 dispatched, ~5 run at once) leaves the
 *  tail panels waiting their turn. Falls back to the toggle (keeps the checkbox
 *  visible), then the last panel, when nothing is running yet; both are list-tail
 *  targets, so they keep `block: 'end'`. */
export function scrollToNewestRunningTerminal(root: Element): boolean {
  const running = root.querySelectorAll('[data-cli-terminal][data-cli-running]');
  const newest = running[running.length - 1];
  if (newest) {
    newest.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }
  const panels = root.querySelectorAll('[data-cli-terminal]');
  const tail = root.querySelector('[data-cli-autoscroll]') ?? panels[panels.length - 1] ?? null;
  if (!tail) return false;
  tail.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return true;
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
