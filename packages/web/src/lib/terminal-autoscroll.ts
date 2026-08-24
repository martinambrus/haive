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

/** The two kinds of ACTIVE run on a step, by invocation id: `running` is started
 *  and not yet ended, `queued` is enqueued but not yet picked up (no slot free).
 *  Kept apart because the scroll TARGET prefers a running run and only falls back
 *  to a queued one — see scrollToNewestActiveTerminal. */
export interface ActiveTerminalIds {
  running: string[];
  queued: string[];
}

/** Set membership either way — the API returns newest-first and a re-sort must not
 *  read as a change. */
function membershipChanged(prev: string[], next: string[]): boolean {
  return next.some((id) => !prev.includes(id)) || prev.some((id) => !next.includes(id));
}

/** Whether a change in a step's ACTIVE terminal ids should move the view.
 *  Follows BOTH sets in BOTH directions: a run starting, a run ending while
 *  siblings keep going, and a fresh run being ENQUEUED. The ending case is the one
 *  users notice — without it the view stays parked on the terminal that just
 *  exited while the still-running ones scroll by unseen.
 *
 *  Tracking `queued` too is what fixes a step whose next run lands behind the
 *  concurrency cap: run 1 ends and run 2 is enqueued in the same poll, so the
 *  RUNNING set empties. Keying on running alone bailed out there (nothing left
 *  running) and the page never scrolled down to the new, waiting terminal.
 *
 *  False on the first observation (the page-level effect owns the initial scroll)
 *  and when nothing is left active at all: the step is wrapping up, and the
 *  page-level effect scrolls to whatever becomes active next — scrolling to this
 *  step's list tail would fight it. */
export function shouldFollowActiveTerminals(
  prev: ActiveTerminalIds | null,
  next: ActiveTerminalIds,
): boolean {
  if (prev === null) return false;
  if (next.running.length === 0 && next.queued.length === 0) return false;
  return (
    membershipChanged(prev.running, next.running) || membershipChanged(prev.queued, next.queued)
  );
}

/** Scroll the newest ACTIVE terminal inside `root` into view. Returns false when
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
 *  Exception: a step with exactly ONE panel frames the STEP top instead, because the
 *  status line describing that run sits above the terminal and panel-top framing is
 *  what scrolls it away. See the call site below.
 *
 *  Target order is RUNNING then QUEUED, both newest-last in document order (panels
 *  render oldest-first), and the preference holds regardless of DOM position: a step
 *  that fans out more invocations than the concurrency cap
 *  (03-phase-0a-discovery: 8 dispatched, ~5 run at once) leaves QUEUED panels at the
 *  tail while earlier ones stream, and the live output is what the user wants on
 *  screen. A queued panel is only the target when NOTHING is running — which is the
 *  case the running-only version could not express, and the reason it left a
 *  waiting terminal off-screen. Last resort is the toggle (keeps the checkbox
 *  visible), then the last panel; both are list-tail targets, so they keep
 *  `block: 'end'`. */
export function scrollToNewestActiveTerminal(root: Element): boolean {
  const panels = root.querySelectorAll('[data-cli-terminal]');
  const running = root.querySelectorAll('[data-cli-terminal][data-cli-running]');
  const queued = root.querySelectorAll('[data-cli-terminal][data-cli-queued]');
  const newest: Element | undefined =
    running[running.length - 1] ?? queued[queued.length - 1] ?? undefined;
  if (newest) {
    // One-panel step: that run's only status line is the STEP's own, which renders
    // ABOVE the terminal — the in-panel copy is gated on 2+ runs (InvocationPanel's
    // `total > 1`). Framing the panel top pushes that line off the screen, so frame
    // the step top instead, exactly like a step with no terminal. `closest` matches
    // the element itself, so it resolves for both call sites: the page-level effect
    // passes the step element, StepTerminal passes its own inner container.
    const stepTop = panels.length === 1 ? root.closest('[data-step-id]') : null;
    (stepTop ?? newest).scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }
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
