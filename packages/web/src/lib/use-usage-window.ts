'use client';

import { useEffect, useState } from 'react';
import { api, type UsageWindowSnapshot } from '@/lib/api-client';

/** The worker writes usage every ~5 minutes, so a faster poll re-reads an unmoved number. */
const POLL_MS = 60_000;

export interface UsageWindowResponse {
  snapshots: UsageWindowSnapshot[];
  alert?: {
    enabled: boolean;
    thresholdPct: number;
    activeProviderIds?: string[];
    allowanceKeys?: Record<string, string>;
  };
}

/* One poller for the page, as in use-global-pause: the task page mounts the usage chip twice
 * beside the app-wide depletion alerts, and each used to poll on its own timer. */
let current: UsageWindowResponse | null = null;
const subscribers = new Set<(data: UsageWindowResponse | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let issued = 0;
let applied = 0;
let inFlight = 0;

async function load(): Promise<void> {
  const id = ++issued;
  inFlight += 1;
  let next: UsageWindowResponse | null;
  try {
    next = await api.get<UsageWindowResponse>('/usage-window');
  } catch {
    next = null;
  } finally {
    inFlight -= 1;
  }
  // A refresh can race a tick, and the older answer must not land last.
  if (id <= applied) return;
  if (next === null) {
    // A failed poll keeps the last answer; a failed first load publishes an empty one, so a
    // chip can name why it has nothing instead of loading forever.
    if (current !== null) return;
    next = { snapshots: [] };
  }
  applied = id;
  current = next;
  for (const notify of subscribers) notify(current);
}

// A reconnect done in another tab shows at once instead of up to a minute later. A return to the
// tab raises visibilitychange and focus together, and one request answers both.
function onVisible(): void {
  if (document.visibilityState === 'visible' && inFlight === 0) void load();
}

/** The latest /usage-window answer, shared by every consumer on the page; null until the
 *  first poll answers. */
export function useUsageWindow(): UsageWindowResponse | null {
  const [data, setData] = useState(current);

  useEffect(() => {
    subscribers.add(setData);
    setData(current);
    if (timer === null) {
      void load();
      timer = setInterval(() => void load(), POLL_MS);
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onVisible);
    }
    return () => {
      subscribers.delete(setData);
      if (subscribers.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
        // The answer is this account's, and the last consumer leaves on sign-out.
        current = null;
        applied = issued;
      }
    };
  }, []);

  return data;
}

/** Polls now, for a repair or a settings change made in this tab. */
export function refreshUsageWindow(): void {
  void load();
}
