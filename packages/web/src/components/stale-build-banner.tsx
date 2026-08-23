'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { shouldWarnStaleBuild } from '@/lib/stale-build';

/** How often to ask what code the server has. Slow on purpose: the answer only matters once a
 *  page has been open long enough to fall behind, and it costs a filesystem scan on the other
 *  end. */
const POLL_MS = 30_000;

/** Production is the case where a moved stamp is PROOF, so it gets to say so outright.
 *
 *  Nothing hot-updates a running production page: the client got its modules once, at load, from
 *  one build. A build id that has moved therefore means this page is the previous build, full
 *  stop, and the copy states that.
 *
 *  Dev cannot make that claim, and the attempt is recorded here so it is not retried. A hot
 *  update lands without a reload, so a moved stamp there means either "you missed it" or "you
 *  already have it", and telling those apart needs a signal from the bundler saying an update
 *  was applied. MEASURED under Turbopack in Next 16.3: `import.meta.turbopackHot` exposes the
 *  webpack-shaped API including `addStatusHandler`, and it is INERT — zero events across a real
 *  hot update of another module. `dispose`/`data` do work (a probe read an incremented
 *  generation off its own replacement), but those fire only for the module that changed, which
 *  is never this one. Asset URLs are no help either: Turbopack dev chunk names are path-derived,
 *  not content-hashed, so an edited chunk keeps its filename.
 *
 *  So dev states the fact it can stand behind — the code moved under this page — and points at
 *  the one action that settles it either way. */
const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Tells a page that the server's code has moved on without it.
 *
 * The failure it exists for: hot reload dies silently. The dev server keeps compiling, every
 * fresh load gets the new bundle, and one tab that was already open keeps running the old
 * modules with nothing on screen saying so. A bug fixed hours earlier then gets re-reported from
 * that tab, and the code being read to explain it is not the code being rendered.
 *
 * Fixed, so it survives scrolling, and parked under the task page's fixed title strip by
 * MEASURING that strip rather than writing its height down — the height is padding plus a line
 * box, so a type change would silently slide this out from under it.
 *
 * `position: sticky` was the first attempt and CANNOT work here: the layout's `<main>` carries
 * `overflow-y: auto` but never actually scrolls (its scrollHeight equals its clientHeight — the
 * document is the real scroller), so a sticky child is bound to a scrollport that never moves
 * and simply scrolls away. The in-flow spacer below is what a fixed bar owes the page in
 * exchange: without it the bar covers the top of the content whenever the page sits at
 * scroll-top.
 */
export function StaleBuildBanner() {
  const [baseline, setBaseline] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [stripOffset, setStripOffset] = useState(0);
  const [barHeight, setBarHeight] = useState(0);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const res = await fetch('/api/app-build', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { stamp?: unknown };
        // Narrowed into a local: inside the updater closure TS widens `body.stamp` back to
        // unknown, since a closure may run later than the guard.
        const stamp = body.stamp;
        if (cancelled || typeof stamp !== 'string') return;
        // The first answer is the code this page was loaded against. Taken from the server
        // rather than assumed, so a page that happens to load mid-edit is not instantly told
        // the code moved under it.
        setBaseline((prev) => prev ?? stamp);
        setCurrent(stamp);
      } catch {
        // A failed poll leaves the last known values alone. Treating a network hiccup, or the
        // login redirect a lapsed session produces, as a change would put a reload prompt on
        // screen with nothing behind it.
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const visible = shouldWarnStaleBuild({ baseline, current, dismissed });

  useEffect(() => {
    if (!visible) {
      setBarHeight(0);
      return;
    }
    // The strip mounts and unmounts as a function of scroll, so scroll is when to re-measure.
    // Capture phase on the document, which catches the scroll wherever it happens — the page
    // scrolls at the document level today, but `<main>` is marked overflow-y-auto and a layout
    // change could hand it the scroll without this noticing.
    const measure = (): void => {
      const strip = document.querySelector('[data-fixed-title-strip]');
      setStripOffset(strip ? Math.round(strip.getBoundingClientRect().height) : 0);
    };
    measure();
    document.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);

    // The spacer matches the bar's real height rather than a written-down one, because the copy
    // wraps to two lines on a narrow window and a fixed number would leave a gap or an overlap.
    const bar = barRef.current;
    const observer = bar
      ? new ResizeObserver(() => setBarHeight(bar.getBoundingClientRect().height))
      : null;
    if (bar) {
      setBarHeight(bar.getBoundingClientRect().height);
      observer?.observe(bar);
    }

    return () => {
      document.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <>
      <div
        ref={barRef}
        role="status"
        style={{ top: stripOffset }}
        // Full-bleed across the content column and opaque, matching the title strip it parks
        // under: a translucent card would show the page scrolling through it. z-20 keeps it
        // below that strip (z-30), which is what makes the measured offset a gap and not an
        // overlap. left-64 is the sidebar width, the same constant the strip uses.
        className="fixed left-64 right-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-sky-500/40 bg-sky-950/95 px-8 py-3 text-sm text-sky-200 backdrop-blur"
      >
        <RefreshCw className="h-5 w-5 shrink-0 text-sky-400" />
        <span className="font-semibold">
          {IS_PROD
            ? 'A newer version of the app was deployed.'
            : 'The app code changed since this page loaded.'}
        </span>
        <span className="text-sky-200/80">
          {IS_PROD
            ? 'This page is still running the previous one.'
            : 'Reload to be certain this tab is running it.'}
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="font-semibold text-sky-100 underline"
        >
          Reload
        </button>
        <button
          type="button"
          onClick={() => setDismissed(current)}
          className="text-sky-200/70 underline"
        >
          Dismiss
        </button>
      </div>
      {/* Holds the space the fixed bar takes out of the top of the page. aria-hidden because the
          bar above already carries the message. */}
      <div aria-hidden style={{ height: barHeight }} />
    </>
  );
}
