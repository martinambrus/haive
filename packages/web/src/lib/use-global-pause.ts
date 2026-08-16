'use client';

import { useEffect, useState } from 'react';
import { api, type SystemPauseResponse } from '@/lib/api-client';

/** How often to re-check the switch. The worker reads it through the ~30s config cache, so
 *  polling much faster than that would only make the UI disagree with reality sooner. */
const POLL_MS = 15_000;

/* One poller for the whole page, not one per consumer.
 *
 * The pause state is read by the app-wide banner AND by every step card and invocation
 * terminal on a task page — a task mid-run can hold a dozen of those, and a hook that owned
 * its own interval would turn one 15s poll into a dozen. So the timer and the last known
 * value live at module scope and each mounted consumer just subscribes; the interval starts
 * on the first subscriber and is cleared when the last one unmounts. */
let currentPaused = false;
const subscribers = new Set<(paused: boolean) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function checkPause(): Promise<void> {
  try {
    const data = await api.get<SystemPauseResponse>('/system/pause');
    if (data.globalPause === currentPaused) return;
    currentPaused = data.globalPause;
    for (const notify of subscribers) notify(currentPaused);
  } catch {
    // A failed poll must not flip the state: claiming "nothing is paused" because the api
    // hiccuped is worse than showing the last known value.
  }
}

/** Whether the admin global-pause switch is on. */
export function useGlobalPause(): boolean {
  const [paused, setPaused] = useState(currentPaused);

  useEffect(() => {
    subscribers.add(setPaused);
    // Re-sync on mount: a consumer mounting between polls would otherwise render the value
    // from whenever the last subscriber left.
    setPaused(currentPaused);
    if (timer === null) {
      void checkPause();
      timer = setInterval(() => void checkPause(), POLL_MS);
    }
    return () => {
      subscribers.delete(setPaused);
      if (subscribers.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  return paused;
}
