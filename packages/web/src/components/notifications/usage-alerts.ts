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
  /** Identity of the ALLOWANCE these numbers describe, from the server (`shared:<cli>` for
   *  the rows that mount one credential volume, `provider:<id>` for an isolated row). The
   *  episode is keyed on this, not on providerId: four `claude-code` provider rows are one
   *  Claude subscription and must produce ONE alert, not four identical ones. */
  allowanceKey: string;
  /** CliProviderName as stored on the snapshot; the caller maps it to a display label. */
  providerName: string;
  windowKey: UsageWindowKey;
  /** 100 - usedPct, i.e. what the header chip shows. The LOWEST reading among the rows
   *  sharing the allowance — they poll seconds apart, so they disagree by a point or two
   *  and the most depleted one is the honest number to warn on. */
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
  return `usage:${alert.allowanceKey}:${alert.windowKey}:${alert.occurrence}`;
}

/**
 * The allowance a provider row spends, from the server's `alert.allowanceKeys` map.
 *
 * Single source of the rule for every consumer — the depletion alerts here and the
 * task-list usage strip both group by it, and if they derived it separately they would
 * eventually disagree about which rows are the same subscription. A providerId the server
 * did not map (older api) falls back to its own id: per-row behaviour, which is merely the
 * old duplication, rather than a guessed grouping that could merge two real subscriptions.
 */
export function allowanceKeyOf(
  providerId: string,
  allowanceKeys?: Readonly<Record<string, string>>,
): string {
  return allowanceKeys?.[providerId] ?? `provider:${providerId}`;
}

/**
 * Episode tag for one window.
 *
 * A parseable reset instant is floored to the MINUTE. Rows sharing a subscription are
 * polled seconds apart and each stamps its own reset time, so the raw strings differ in
 * the milliseconds (`…:59.320Z` vs `…:59.477Z`) — keying on them verbatim would hand every
 * row a distinct episode and defeat the collapse, and would re-fire whenever the winning
 * row changed. A minute is many orders of magnitude finer than the shortest window (5
 * hours), so two genuinely different windows can never land in the same bucket.
 *
 * An unparseable value is used verbatim (nothing better to do with it), and a missing one
 * falls back to a fixed-epoch bucket of the window's nominal length — zai never reports a
 * reset time at all.
 */
export function episodeOccurrence(
  resetsAt: string | null,
  windowKey: UsageWindowKey,
  now: number,
): string {
  if (!resetsAt) return `b${Math.floor(now / WINDOW_MS[windowKey])}`;
  const parsed = Date.parse(resetsAt);
  return Number.isNaN(parsed) ? resetsAt : `m${Math.floor(parsed / 60_000)}`;
}

/**
 * Every window at or below the remaining-% threshold, across every provider the caller
 * currently has live work on.
 *
 * Skips snapshots that are not `ok` (an errored or reconnect-needing provider has no
 * trustworthy number) and snapshots that are `stale` — a reading the poller stopped
 * refreshing is frozen, and warning off a frozen number is worse than staying quiet.
 *
 * Also skips any provider absent from `activeProviderIds` (the server's set of CLIs with a
 * running task or an in-flight invocation). A depletion warning is only actionable while
 * something is spending that allowance: once every task on the CLI has failed on the
 * exhausted window, re-warning each time a new 5-hour window rolls over is pure noise, and
 * the recovery side is covered by the separate allowance-replenished channel, which is
 * armed per failed task. An empty set therefore silences the channel — the same way a
 * missing `alert` object already does in the caller.
 *
 * Collapses to ONE alert per (allowance, window). Several provider rows can front the same
 * subscription — `allowanceKeys` maps each providerId to the credential set it spends — and
 * warning once per row is what turned a single depleting Claude allowance into four
 * identical notifications. The most depleted reading among them wins, so the collapse never
 * makes the situation look better than it is. A providerId missing from the map (older api)
 * falls back to its own id, i.e. today's per-row behaviour rather than a wrong grouping.
 *
 * Emitting an alert is not the same as showing it: the caller still has to check the
 * episode against the seen-store.
 */
export function detectUsageAlerts(
  snapshots: readonly UsageWindowSnapshot[],
  opts: {
    thresholdPct: number;
    now: number;
    activeProviderIds: readonly string[];
    allowanceKeys?: Readonly<Record<string, string>>;
  },
): UsageAlert[] {
  const active = new Set(opts.activeProviderIds);
  // Insertion-ordered, so the emitted order still follows WINDOW_KEYS within a provider
  // and snapshot order across providers.
  const byEpisode = new Map<string, UsageAlert>();
  for (const snap of snapshots) {
    if (snap.status !== 'ok' || snap.stale) continue;
    if (!active.has(snap.providerId)) continue;
    const allowanceKey = allowanceKeyOf(snap.providerId, opts.allowanceKeys);
    for (const windowKey of WINDOW_KEYS) {
      const window = snap[windowKey];
      if (!window) continue;
      const remainingPct = 100 - window.usedPct;
      if (remainingPct > opts.thresholdPct) continue;
      const alert: UsageAlert = {
        providerId: snap.providerId,
        allowanceKey,
        providerName: snap.providerName,
        windowKey,
        remainingPct,
        resetsAt: window.resetsAt,
        occurrence: episodeOccurrence(window.resetsAt, windowKey, opts.now),
      };
      // Group on the allowance + window ALONE, never on the occurrence: the rows sharing a
      // subscription each stamp their own reset time, and two that straddle a minute
      // boundary would otherwise split back into two alerts. The winner's occurrence is
      // what keys the episode, and minute-flooring keeps that stable when the winner flips.
      const groupKey = `${allowanceKey}|${windowKey}`;
      const existing = byEpisode.get(groupKey);
      if (!existing || remainingPct < existing.remainingPct) byEpisode.set(groupKey, alert);
    }
  }
  return [...byEpisode.values()];
}
