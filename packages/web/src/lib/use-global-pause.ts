'use client';

import { useEffect, useState } from 'react';
import { api, type SystemStateResponse } from '@/lib/api-client';
import type { MaintenanceState } from '@haive/shared/system';

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
let currentMaintenance: MaintenanceState = 'normal';
const subscribers = new Set<(paused: boolean) => void>();
const maintenanceSubscribers = new Set<(state: MaintenanceState) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/* One request carries BOTH holds. `/system/state` reports the orchestrator pause and the
 * maintenance state together, so adding the second did not add a second poller — and the two
 * can never be read a poll apart from each other.
 *
 * It keeps answering during full maintenance because `/system/*` is exempt from the api's
 * maintenance gate. That is what lets a locked-out user be TOLD they are locked out instead of
 * watching every request fail with nothing explaining why. */
async function checkState(): Promise<void> {
  try {
    const data = await api.get<SystemStateResponse>('/system/state');
    if (data.globalPause !== currentPaused) {
      currentPaused = data.globalPause;
      for (const notify of subscribers) notify(currentPaused);
    }
    if (data.maintenance !== currentMaintenance) {
      currentMaintenance = data.maintenance;
      for (const notify of maintenanceSubscribers) notify(currentMaintenance);
    }
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
      void checkState();
      timer = setInterval(() => void checkState(), POLL_MS);
    }
    return () => {
      subscribers.delete(setPaused);
      if (subscribers.size === 0 && maintenanceSubscribers.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  return paused;
}

/** The system-wide maintenance state. Shares the poller above, so it costs no extra request. */
export function useMaintenanceState(): MaintenanceState {
  const [state, setState] = useState(currentMaintenance);

  useEffect(() => {
    maintenanceSubscribers.add(setState);
    setState(currentMaintenance);
    if (timer === null) {
      void checkState();
      timer = setInterval(() => void checkState(), POLL_MS);
    }
    return () => {
      maintenanceSubscribers.delete(setState);
      if (subscribers.size === 0 && maintenanceSubscribers.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  return state;
}
