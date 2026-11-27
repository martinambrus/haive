/** Why the task header's subscription meter is not showing bars, decided once instead of by a
 *  chain of early returns inside the component.
 *
 *  The chip used to return null for every non-`ok` case, so four unrelated situations rendered
 *  one identical blank: a CLI that publishes no usage endpoint at all, a provider that has
 *  never produced a reading, a failed fetch, and a vendor that answered with no window. All
 *  four are now named. The unmetered CLI was the one deliberate blank, on the argument that
 *  ollama and grok have no allowance to report and saying so on every such step is noise — but
 *  the chip follows the CURRENT STEP's CLI, and a task can run each step on a different one, so
 *  that blank read as the meter breaking mid-run: a live "8% left" on one step vanishing
 *  entirely on the next says nothing about which of the two it belongs to. A line of text
 *  holding the slot is what distinguishes "this CLI has no meter" from "the meter is gone".
 *
 *  It stays silent only while the CLI is genuinely UNKNOWN — the task page fills its provider
 *  list asynchronously, so `providerName` is null for the first frames and a claim made there
 *  would be a guess that flips a moment later.
 *
 *  Pure and unit-tested, like usage-strip-select and step-banners — the component renders what
 *  this returns and decides nothing itself. */

import { hasUsageWindow } from '@haive/shared/usage-window';
import type { CliProviderName, UsageWindowSnapshot } from '@/lib/api-client';

export const isMeteredCli = hasUsageWindow;

export type UsageChipFault = 'not_connected' | 'unavailable' | 'no_windows' | 'no_meter';

export type UsageChipState =
  /** Render nothing: no provider resolved, snapshots not loaded yet, or the provider row has
   *  not arrived so which CLI this is remains unknown. */
  | { kind: 'hidden' }
  | { kind: 'meter'; snapshot: UsageWindowSnapshot }
  | { kind: 'pending' }
  | { kind: 'reconnect' }
  | { kind: 'fault'; fault: UsageChipFault };

export function resolveUsageChipState(args: {
  providerId: string | null;
  providerName: CliProviderName | null;
  providerAuthMode?: 'subscription' | 'api_key';
  snapshots: readonly UsageWindowSnapshot[] | null;
}): UsageChipState {
  const { providerId, providerName, snapshots } = args;
  if (!providerId || !snapshots) return { kind: 'hidden' };
  // Claude usage OAuth is subscription-only, including the empty-meter fallback.
  if (providerName === 'claude-code' && !hasUsageWindow(providerName, args.providerAuthMode))
    return { kind: 'hidden' };

  const snap = snapshots.find((s) => s.providerId === providerId);
  if (!snap) {
    // No row at all, which two very different situations produce. For a metered CLI the poller
    // never got a reading for this provider — not signed in, or never polled — a fault a user
    // can act on. For any other CLI it is the normal permanent state, stated rather than left
    // blank so the header keeps a line where the bars were on the previous step's CLI.
    if (hasUsageWindow(providerName, args.providerAuthMode))
      return { kind: 'fault', fault: 'not_connected' };
    // Which CLI this is has not been established yet (the provider list loads after the task),
    // so there is nothing to make a claim about. Blank, not "no meter" — the latter would be a
    // guess that contradicts itself one render later.
    return providerName ? { kind: 'fault', fault: 'no_meter' } : { kind: 'hidden' };
  }
  if (snap.status === 'pending') return { kind: 'pending' };
  if (snap.status === 'needs_reconnect') return { kind: 'reconnect' };
  if (snap.status === 'error') return { kind: 'fault', fault: 'unavailable' };

  // status 'ok'. Mirrors usageWindowsOf (components/usage-meter) as a field test rather than a
  // call, so this module stays clear of the component tree; the two must name the same three
  // windows, and a fourth window added there belongs here too.
  if (!snap.fiveHour && !snap.sevenDay && !snap.daily) {
    return { kind: 'fault', fault: 'no_windows' };
  }
  return { kind: 'meter', snapshot: snap };
}

/** Chip text per fault — short enough to sit in the title strip beside the step badges. */
export function usageFaultText(fault: UsageChipFault): string {
  switch (fault) {
    case 'not_connected':
      return 'usage not connected';
    case 'unavailable':
      return 'usage unavailable';
    case 'no_windows':
      return 'no usage data';
    case 'no_meter':
      return 'no usage meter';
  }
}

/** The hover text, which is where the actual explanation lives. */
export function usageFaultTooltip(fault: UsageChipFault, displayName: string): string {
  switch (fault) {
    case 'not_connected':
      return `${displayName} does publish a usage endpoint, but no reading has arrived for this provider — it is most likely not signed in. Connect it on the CLI providers page.`;
    case 'unavailable':
      return `${displayName}'s last usage reading failed. Haive retries on the next poll, roughly every 5 minutes — no action needed unless it persists.`;
    case 'no_windows':
      return `${displayName} answered, but reported no usage window, so there is no allowance to show for this step.`;
    case 'no_meter':
      return `${displayName} publishes no usage endpoint, so there is no subscription allowance to report for this step. Nothing is wrong and no reading is coming.`;
  }
}

/** Only the actionable fault gets a destination; the rest are statements of fact. */
export function usageFaultHref(fault: UsageChipFault): string | null {
  return fault === 'not_connected' ? '/cli-providers' : null;
}
