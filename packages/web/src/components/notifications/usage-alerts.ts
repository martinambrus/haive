/** Pure diffing of a /usage-window poll into subscription-depletion alerts. DOM-free
 *  so it can run under vitest's node environment, same as transitions.ts. */

import type { UsageWindowSnapshot } from '@/lib/api-client';

export type UsageWindowKey = 'fiveHour' | 'sevenDay' | 'daily';

/** Iteration order — also the order alerts appear in for a provider exposing several. */
const WINDOW_KEYS: readonly UsageWindowKey[] = ['fiveHour', 'sevenDay', 'daily'];

/** Nominal length of each window. Used ONLY to bucket the alert episode for providers
 *  whose vendor omits resetsAt (zai always; the others when the payload lacks it), where
 *  there is no authoritative boundary to key on. */
export const WINDOW_MS: Record<UsageWindowKey, number> = {
  fiveHour: 5 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  sevenDay: 7 * 24 * 60 * 60 * 1000,
};

/** Human name for the window, used in the toast title and notification body. */
export const WINDOW_LABEL: Record<UsageWindowKey, string> = {
  fiveHour: '5-hour',
  sevenDay: 'weekly',
  daily: 'daily',
};

export interface UsageAlert {
  providerId: string;
  /** CliProviderName as stored on the snapshot; the caller maps it to a display label. */
  providerName: string;
  windowKey: UsageWindowKey;
  /** 100 - usedPct, i.e. what the header chip shows. */
  remainingPct: number;
  resetsAt: string | null;
  /** Tags the depletion EPISODE so one window alerts once, not once per poll. The
   *  vendor reset time when there is one — a new window carries a new resetsAt, which
   *  is exactly the trick currentWaitStartedAt plays for gates in transitions.ts — else
   *  a fixed-epoch time bucket of the window's nominal length. */
  occurrence: string;
}

/** Persistent seen-store key for one depletion episode. Deliberately prefixed to slot
 *  under the provider's existing `haive:notif-seen:` namespace, so its 7-day TTL prune
 *  sweeps these too without any change to the prune loop. */
export function usageEpisodeKey(alert: UsageAlert): string {
  return `usage:${alert.providerId}:${alert.windowKey}:${alert.occurrence}`;
}

/**
 * Every window at or below the remaining-% threshold, across every provider.
 *
 * Skips snapshots that are not `ok` (an errored or reconnect-needing provider has no
 * trustworthy number) and snapshots that are `stale` — a reading the poller stopped
 * refreshing is frozen, and warning off a frozen number is worse than staying quiet.
 * Emitting an alert is not the same as showing it: the caller still has to check the
 * episode against the seen-store.
 */
export function detectUsageAlerts(
  snapshots: readonly UsageWindowSnapshot[],
  opts: { thresholdPct: number; now: number },
): UsageAlert[] {
  const alerts: UsageAlert[] = [];
  for (const snap of snapshots) {
    if (snap.status !== 'ok' || snap.stale) continue;
    for (const windowKey of WINDOW_KEYS) {
      const window = snap[windowKey];
      if (!window) continue;
      const remainingPct = 100 - window.usedPct;
      if (remainingPct > opts.thresholdPct) continue;
      alerts.push({
        providerId: snap.providerId,
        providerName: snap.providerName,
        windowKey,
        remainingPct,
        resetsAt: window.resetsAt,
        occurrence: window.resetsAt ?? `b${Math.floor(opts.now / WINDOW_MS[windowKey])}`,
      });
    }
  }
  return alerts;
}
