import { describe, it, expect } from 'vitest';
import {
  isMeteredCli,
  resolveUsageChipState,
  usageFaultHref,
  usageFaultText,
  usageFaultTooltip,
} from './usage-chip-state';
import type { UsageWindowSnapshot } from '@/lib/api-client';

// Four situations used to render one identical blank. The point of this module is that none of
// them still do: the chip follows the current step's CLI, so a blank is indistinguishable from
// the meter breaking when the next step switches CLI. The only blank left is the CLI nobody has
// identified yet, where there is no claim to make.

const PROVIDER = 'p0000000-0000-0000-0000-00000000000a';

function snap(over: Partial<UsageWindowSnapshot> = {}): UsageWindowSnapshot {
  return {
    providerId: PROVIDER,
    providerName: 'codex',
    fetchedAt: '2026-08-22T00:00:00.000Z',
    stale: false,
    status: 'ok',
    sevenDay: { usedPct: 40, resetsAt: null },
    ...over,
  };
}

describe('isMeteredCli', () => {
  it('knows the CLIs a reading can exist for', () => {
    expect(isMeteredCli('codex')).toBe(true);
    expect(isMeteredCli('claude-code')).toBe(true);
    expect(isMeteredCli('zai')).toBe(true);
    expect(isMeteredCli('gemini')).toBe(true);
  });

  it('rejects the CLIs that publish no usage endpoint', () => {
    expect(isMeteredCli('ollama')).toBe(false);
    expect(isMeteredCli('grok')).toBe(false);
    expect(isMeteredCli('amp')).toBe(false);
    expect(isMeteredCli('antigravity')).toBe(false);
    expect(isMeteredCli(null)).toBe(false);
  });
});

describe('resolveUsageChipState', () => {
  it('hides when no provider is resolved', () => {
    expect(
      resolveUsageChipState({ providerId: null, providerName: 'codex', snapshots: [] }),
    ).toEqual({ kind: 'hidden' });
  });

  it('hides while snapshots are still loading', () => {
    expect(
      resolveUsageChipState({ providerId: PROVIDER, providerName: 'codex', snapshots: null }),
    ).toEqual({ kind: 'hidden' });
  });

  // Was the deliberate blank. Now stated: the chip tracks the CURRENT step's CLI, and a task
  // that runs one step on Claude and the next on ollama otherwise loses the whole badge
  // mid-run, which reads as the meter failing rather than as this CLI having none.
  it('names a CLI with no usage endpoint instead of blanking', () => {
    expect(
      resolveUsageChipState({ providerId: PROVIDER, providerName: 'ollama', snapshots: [] }),
    ).toEqual({ kind: 'fault', fault: 'no_meter' });
  });

  // The one blank that survives. `providers` on the task page starts empty and fills after the
  // task loads, so an unresolved name is "not known yet", not "known to be unmetered" — and
  // calling it unmetered there would flash a wrong claim that corrects itself a render later.
  it('stays blank while the CLI itself is still unknown', () => {
    expect(
      resolveUsageChipState({ providerId: PROVIDER, providerName: null, snapshots: [] }),
    ).toEqual({ kind: 'hidden' });
  });

  // Same input shape as the case above — no row — but a different answer, which is the whole
  // reason the metered-CLI list has to exist on this side at all.
  it('reports a metered CLI that produced no reading as not connected', () => {
    expect(
      resolveUsageChipState({ providerId: PROVIDER, providerName: 'codex', snapshots: [] }),
    ).toEqual({ kind: 'fault', fault: 'not_connected' });
  });

  it('reports a failed fetch as unavailable', () => {
    expect(
      resolveUsageChipState({
        providerId: PROVIDER,
        providerName: 'codex',
        snapshots: [snap({ status: 'error' })],
      }),
    ).toEqual({ kind: 'fault', fault: 'unavailable' });
  });

  it('reports an ok reading carrying no window', () => {
    expect(
      resolveUsageChipState({
        providerId: PROVIDER,
        providerName: 'codex',
        snapshots: [snap({ sevenDay: undefined })],
      }),
    ).toEqual({ kind: 'fault', fault: 'no_windows' });
  });

  // The repair states keep their own chips and must not be swallowed by the fault branch.
  it('keeps needs_reconnect and pending distinct from a fault', () => {
    expect(
      resolveUsageChipState({
        providerId: PROVIDER,
        providerName: 'codex',
        snapshots: [snap({ status: 'needs_reconnect' })],
      }),
    ).toEqual({ kind: 'reconnect' });
    expect(
      resolveUsageChipState({
        providerId: PROVIDER,
        providerName: 'codex',
        snapshots: [snap({ status: 'pending' })],
      }),
    ).toEqual({ kind: 'pending' });
  });

  it('draws the meter when a window is present', () => {
    const s = snap();
    expect(
      resolveUsageChipState({ providerId: PROVIDER, providerName: 'codex', snapshots: [s] }),
    ).toEqual({ kind: 'meter', snapshot: s });
  });

  it('matches on provider id, not on CLI name', () => {
    expect(
      resolveUsageChipState({
        providerId: PROVIDER,
        providerName: 'codex',
        snapshots: [snap({ providerId: 'someone-else' })],
      }),
    ).toEqual({ kind: 'fault', fault: 'not_connected' });
  });

  // A stale reading is still a reading: the chip dims it rather than calling it a fault.
  it('treats a stale ok reading as a meter', () => {
    const s = snap({ stale: true });
    expect(
      resolveUsageChipState({ providerId: PROVIDER, providerName: 'codex', snapshots: [s] }),
    ).toEqual({ kind: 'meter', snapshot: s });
  });
});

describe('fault copy', () => {
  it('gives every fault text and a tooltip naming the provider', () => {
    for (const fault of ['not_connected', 'unavailable', 'no_windows', 'no_meter'] as const) {
      expect(usageFaultText(fault).length).toBeGreaterThan(0);
      expect(usageFaultTooltip(fault, 'Codex')).toContain('Codex');
    }
  });

  it('offers a destination only for the fault a user can act on', () => {
    expect(usageFaultHref('not_connected')).toBe('/settings/cli-providers');
    expect(usageFaultHref('unavailable')).toBeNull();
    expect(usageFaultHref('no_windows')).toBeNull();
    expect(usageFaultHref('no_meter')).toBeNull();
  });
});
