'use client';
import { useEffect, useRef, useState } from 'react';
import { ActivityClock } from './activity-clock';
import { AttentionLease } from './attention-lease';
import { visibleWords } from './visible-words';

export const ACTIVE_TIME_SAMPLE_MS = 1000;
export const ACTIVE_TIME_FLUSH_MS = 60000;
export const READING_MEASURE_DELAY_MS = 2000;
export type ActiveTimeSink = (deltaMs: number) => void | Promise<unknown>;
type Options = {
  enabled: boolean;
  pending: boolean;
  contentKey: unknown;
  /** Stable identity per destination. A change flushes the old destination first. */
  sink: ActiveTimeSink;
  baseMs?: number;
};

export function useActiveTime({ enabled, pending, contentKey, sink, baseMs = 0 }: Options): number {
  const latest = useRef({ pending, contentKey, baseMs });
  latest.current = { pending, contentKey, baseMs };
  const clockRef = useRef<ActivityClock | null>(null);
  const keyRef = useRef(contentKey);
  const updateRef = useRef<(() => void) | null>(null);
  const [display, setDisplay] = useState({ sink, total: baseMs });
  const shown = useRef(display);

  useEffect(() => {
    const now = () => performance.now();
    const clock = clockRef.current ?? (clockRef.current = new ActivityClock(now()));
    if (!enabled) return;
    let committed = latest.current.baseMs,
      unflushed = 0,
      lastFlush = now();
    let foreground = document.visibilityState === 'visible' && document.hasFocus();
    let pointerDown = false;
    let pointer: { x: number; y: number } | null = null;
    let measureTimer: ReturnType<typeof setTimeout> | undefined;
    let lease: AttentionLease | null = null;
    try {
      lease = new AttentionLease(window.localStorage, crypto.randomUUID());
    } catch {
      /* fail closed */
    }
    const iframeFocused = () => document.activeElement?.tagName === 'IFRAME';
    const show = () => {
      const total = committed + unflushed;
      if (shown.current.sink === sink && shown.current.total === total) return;
      shown.current = { sink, total };
      setDisplay(shown.current);
    };
    // Acquisition sets the baseline. Only ticks renew the lease after that.
    let leaseTick = -1;
    let held = false;
    const touchLease = () => {
      const tick = Math.floor(now() / ACTIVE_TIME_SAMPLE_MS);
      if (tick !== leaseTick) {
        leaseTick = tick;
        held = lease?.touch() ?? false;
      }
      return held;
    };
    touchLease();
    held = lease?.acquired ?? false;
    const flush = () => {
      let delta = Math.round(unflushed);
      if (delta <= 0) return;
      unflushed = 0;
      committed += delta;
      lastFlush = now();
      show();
      // Discard before dispatch: an ambiguous additive request must never be retried.
      while (delta > 0) {
        const chunk = Math.min(delta, ACTIVE_TIME_FLUSH_MS);
        delta -= chunk;
        try {
          void Promise.resolve(sink(chunk)).catch(() => {});
        } catch {
          /* best effort */
        }
      }
    };
    const sample = () => {
      const eligible = enabled && foreground;
      unflushed += clock.sample(now(), eligible && held);
      if (!eligible) lease?.release();
      show();
    };
    const scheduleMeasurement = () => {
      clearTimeout(measureTimer);
      if (!enabled || !foreground) return;
      const epoch = clock.epoch;
      measureTimer = setTimeout(() => {
        // Deadline stays anchored to the input, even if this callback ran late.
        clock.setReadingWords(epoch, visibleWords() ?? 0);
      }, READING_MEASURE_DELAY_MS);
    };
    const update = () => {
      clock.setModes(now(), latest.current.pending, iframeFocused());
      if (!Object.is(keyRef.current, latest.current.contentKey)) {
        keyRef.current = latest.current.contentKey;
        clock.content(now(), true);
        scheduleMeasurement();
      }
    };
    updateRef.current = update;
    clock.sample(now(), false); // activation never backfills the previous destination
    update();
    scheduleMeasurement();

    const input = () => {
      clock.input(now(), true);
      scheduleMeasurement();
    };
    const onInput = (event: Event) => {
      if (!event.isTrusted || !foreground) return;
      if (event.type === 'pointermove') {
        const e = event as PointerEvent;
        const changed = pointer !== null && (e.clientX !== pointer.x || e.clientY !== pointer.y);
        pointer = { x: e.clientX, y: e.clientY };
        if (!changed) return;
      }
      if (event.type === 'pointerdown') {
        const e = event as PointerEvent;
        pointerDown = true;
        pointer = { x: e.clientX, y: e.clientY };
      }
      if (event.type === 'scroll' && !pointerDown) return;
      input();
    };
    const onPointerUp = (event: Event) => {
      if (event.isTrusted) pointerDown = false;
    };
    const onBlur = (event: FocusEvent) => {
      if (event.target !== window || !event.isTrusted) return;
      sample(); // finish the formerly focused interval BEFORE changing foreground
      pointerDown = false;
      if (iframeFocused() && document.hasFocus() && document.visibilityState === 'visible') {
        clock.setModes(now(), latest.current.pending, true); // entry only; never renewed by ticks
        foreground = true;
      } else {
        foreground = false;
        clearTimeout(measureTimer);
        lease?.release();
      }
      clock.sample(now(), false);
      flush();
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target !== window || !event.isTrusted) return;
      foreground = document.visibilityState === 'visible';
      clock.sample(now(), false);
      clock.setModes(now(), latest.current.pending, iframeFocused());
      if (foreground) {
        touchLease(); // focus establishes a baseline; capture input never touches storage
        held = lease?.acquired ?? false;
        input();
      }
    };
    const onVisibility = () => {
      sample();
      foreground = document.visibilityState === 'visible' && document.hasFocus();
      pointerDown = false;
      clock.sample(now(), false);
      if (!foreground) {
        clearTimeout(measureTimer);
        lease?.release();
        flush();
      }
    };
    const onPageHide = () => {
      sample();
      foreground = false;
      lease?.release();
      flush();
    };
    const inputEvents = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchmove', 'scroll'];
    for (const type of inputEvents)
      window.addEventListener(type, onInput, { capture: true, passive: true });
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    window.addEventListener('blur', onBlur, true);
    window.addEventListener('focus', onFocus, true);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    const interval = setInterval(() => {
      held = foreground ? touchLease() : false;
      sample();
      // Leaving an iframe restores this epoch's reading deadline; staying never renews it.
      clock.setModes(now(), latest.current.pending, iframeFocused());
      if (now() - lastFlush >= ACTIVE_TIME_FLUSH_MS) flush();
    }, ACTIVE_TIME_SAMPLE_MS);
    return () => {
      sample();
      flush(); // closes over the OLD sink
      lease?.release();
      clearInterval(interval);
      clearTimeout(measureTimer);
      updateRef.current = null;
      for (const type of inputEvents) window.removeEventListener(type, onInput, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      window.removeEventListener('blur', onBlur, true);
      window.removeEventListener('focus', onFocus, true);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, sink]);

  useEffect(() => {
    updateRef.current?.();
  }, [pending, contentKey]);
  return display.sink === sink ? display.total : baseMs;
}
