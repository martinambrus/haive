import type { Task, UsageWindowSnapshot } from '@/lib/api-client';
// Relative, not the `@/` alias: this module is unit-tested and the web package has no
// vitest config, so an aliased VALUE import would not resolve under the test runner (the
// aliased type imports above are erased and stay fine).
import { allowanceKeyOf } from './notifications/usage-alerts';

/** Which subscription meters the task list should show, and which snapshot speaks for each.
 *
 *  Scoped to the rows CURRENTLY ON SCREEN. The list filters server-side, so `tasks` is
 *  exactly what the user is looking at; filtering to Codex should not leave a Claude meter
 *  hanging above the list, and an unfiltered list should show both.
 *
 *  Grouped by allowance, never by provider row: 25 `claude-code` rows front one Claude
 *  login, so keying on providerId would print the same meter 25 times — the duplication the
 *  depletion alerts already had to remove. The identity comes from allowanceKeyOf so the
 *  strip and the alerts can never disagree about what counts as one subscription. */

export interface StripMeter {
  allowanceKey: string;
  snapshot: UsageWindowSnapshot;
}

/** Lowest remaining headroom across a snapshot's windows, i.e. how close it is to running
 *  out. Used to choose a representative among rows sharing an allowance — they poll seconds
 *  apart and disagree by a point, and the most depleted reading is the honest one to show.
 *  A snapshot exposing no window sorts last (nothing to display). */
function worstRemaining(snap: UsageWindowSnapshot): number {
  const pcts = [snap.fiveHour, snap.sevenDay, snap.daily]
    .filter((w): w is NonNullable<typeof w> => Boolean(w))
    .map((w) => 100 - w.usedPct);
  return pcts.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...pcts);
}

export function selectStripMeters(
  tasks: readonly Task[] | null,
  snapshots: readonly UsageWindowSnapshot[] | null,
  allowanceKeys?: Readonly<Record<string, string>>,
): StripMeter[] {
  if (!tasks || !snapshots) return [];

  // Allowances the visible rows actually spend. A task with no CLI set contributes none.
  const visible = new Set<string>();
  for (const task of tasks) {
    if (task.cliProviderId) visible.add(allowanceKeyOf(task.cliProviderId, allowanceKeys));
  }
  if (visible.size === 0) return [];

  const byAllowance = new Map<string, UsageWindowSnapshot>();
  for (const snap of snapshots) {
    // Only readable numbers: an errored or reconnect-needing snapshot has nothing
    // trustworthy to draw, and a provider may still have a healthy sibling on the same
    // subscription. Stale is kept — the chip dims it rather than hiding it.
    if (snap.status !== 'ok') continue;
    const key = allowanceKeyOf(snap.providerId, allowanceKeys);
    if (!visible.has(key)) continue;
    const current = byAllowance.get(key);
    if (!current || worstRemaining(snap) < worstRemaining(current)) byAllowance.set(key, snap);
  }

  return (
    [...byAllowance.entries()]
      .map(([allowanceKey, snapshot]) => ({ allowanceKey, snapshot }))
      // Stable order so the strip does not reshuffle on every 3s poll.
      .sort((a, b) => a.allowanceKey.localeCompare(b.allowanceKey))
  );
}
