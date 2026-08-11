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
  /** 'ok' draws the bars. 'needs_reconnect' draws a repair prompt instead: the subscription
   *  has no readable reading left AND a user action is what restores it, which is worth a
   *  line on the page the user is already on. 'pending' says the repair is done and a reading
   *  is on its way — never a prompt, or the user re-does a fix that already worked. A plain
   *  `error` gets none of them: nothing to show and nothing to do about it. */
  status: 'ok' | 'needs_reconnect' | 'pending';
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
  const deadByAllowance = new Map<string, UsageWindowSnapshot>();
  const pendingByAllowance = new Map<string, UsageWindowSnapshot>();
  for (const snap of snapshots) {
    const key = allowanceKeyOf(snap.providerId, allowanceKeys);
    if (!visible.has(key)) continue;
    if (snap.status === 'needs_reconnect' || snap.status === 'pending') {
      // Held aside, not drawn yet: a healthy sibling row on the same subscription still
      // speaks for it. Ties broken on provider id rather than array order so the strip picks
      // the same row on every poll.
      const bucket = snap.status === 'pending' ? pendingByAllowance : deadByAllowance;
      const held = bucket.get(key);
      if (!held || snap.providerId < held.providerId) bucket.set(key, snap);
      continue;
    }
    // Only readable numbers: an errored snapshot has nothing trustworthy to draw and no
    // repair to offer. Stale is kept — the chip dims it rather than hiding it.
    if (snap.status !== 'ok') continue;
    const current = byAllowance.get(key);
    if (!current || worstRemaining(snap) < worstRemaining(current)) byAllowance.set(key, snap);
  }

  const meters: StripMeter[] = [...byAllowance.entries()].map(([allowanceKey, snapshot]) => ({
    allowanceKey,
    snapshot,
    status: 'ok' as const,
  }));
  // Prompt only for a subscription that produced NO reading at all. A live number always
  // beats a repair nag, so one healthy row suppresses its dead siblings — and a repair
  // already under way outranks the prompt for the same reason: telling someone to reconnect
  // what they just reconnected is the one message guaranteed to be wrong.
  for (const [allowanceKey, snapshot] of deadByAllowance) {
    if (byAllowance.has(allowanceKey) || pendingByAllowance.has(allowanceKey)) continue;
    meters.push({ allowanceKey, snapshot, status: 'needs_reconnect' });
  }
  for (const [allowanceKey, snapshot] of pendingByAllowance) {
    if (byAllowance.has(allowanceKey)) continue;
    meters.push({ allowanceKey, snapshot, status: 'pending' });
  }
  // Stable order so the strip does not reshuffle on every 3s poll.
  return meters.sort((a, b) => a.allowanceKey.localeCompare(b.allowanceKey));
}
