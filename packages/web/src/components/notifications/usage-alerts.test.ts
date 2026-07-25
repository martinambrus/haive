import { describe, expect, it } from 'vitest';
import type { UsageWindowSnapshot } from '@/lib/api-client';
import { WINDOW_MS, detectUsageAlerts, usageEpisodeKey } from './usage-alerts';

const snap = (over: Partial<UsageWindowSnapshot> = {}): UsageWindowSnapshot => ({
  providerId: 'p1',
  providerName: 'codex',
  fetchedAt: '2026-07-24T10:00:00.000Z',
  stale: false,
  status: 'ok',
  ...over,
});

const NOW = Date.UTC(2026, 6, 24, 10, 0, 0);

/** Default the gate open for the cases that aren't about it: p1 and p2 are the only
 *  providers the fixtures use. */
const ACTIVE = ['p1', 'p2'];

describe('detectUsageAlerts', () => {
  it('fires exactly at the threshold and stays quiet one point above it', () => {
    const at = detectUsageAlerts([snap({ sevenDay: { usedPct: 90, resetsAt: 'r1' } })], {
      thresholdPct: 10,
      now: NOW,
      activeProviderIds: ACTIVE,
    });
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ windowKey: 'sevenDay', remainingPct: 10, occurrence: 'r1' });

    const above = detectUsageAlerts([snap({ sevenDay: { usedPct: 89, resetsAt: 'r1' } })], {
      thresholdPct: 10,
      now: NOW,
      activeProviderIds: ACTIVE,
    });
    expect(above).toEqual([]);
  });

  it('stays silent for a depleted CLI nothing is running on, and only for that CLI', () => {
    // The reported case: every codex task has already failed on the exhausted window, so
    // codex is absent from the active set while claude-code keeps running. Warning about
    // codex there is unactionable — the allowance-replenished channel owns the recovery.
    const depleted = { fiveHour: { usedPct: 100, resetsAt: 'r1' } };
    const alerts = detectUsageAlerts(
      [
        snap({ providerId: 'codex-1', providerName: 'codex', ...depleted }),
        snap({ providerId: 'claude-1', providerName: 'claude-code', ...depleted }),
      ],
      { thresholdPct: 10, now: NOW, activeProviderIds: ['claude-1'] },
    );
    expect(alerts.map((a) => a.providerId)).toEqual(['claude-1']);
  });

  it('silences every provider when nothing is running', () => {
    const opts = { thresholdPct: 10, now: NOW, activeProviderIds: [] };
    expect(detectUsageAlerts([snap({ fiveHour: { usedPct: 99, resetsAt: 'r1' } })], opts)).toEqual(
      [],
    );
  });

  it('skips stale, errored and reconnect-needing snapshots', () => {
    const depleted = { fiveHour: { usedPct: 99, resetsAt: 'r1' } };
    const opts = { thresholdPct: 10, now: NOW, activeProviderIds: ACTIVE };
    expect(detectUsageAlerts([snap({ ...depleted, stale: true })], opts)).toEqual([]);
    expect(detectUsageAlerts([snap({ ...depleted, status: 'error' })], opts)).toEqual([]);
    expect(detectUsageAlerts([snap({ ...depleted, status: 'needs_reconnect' })], opts)).toEqual([]);
  });

  it('emits one independent alert per exposed window', () => {
    const alerts = detectUsageAlerts(
      [
        snap({
          fiveHour: { usedPct: 95, resetsAt: 'r5h' },
          sevenDay: { usedPct: 92, resetsAt: 'r7d' },
        }),
      ],
      { thresholdPct: 10, now: NOW, activeProviderIds: ACTIVE },
    );
    expect(alerts.map((a) => a.windowKey)).toEqual(['fiveHour', 'sevenDay']);
    expect(new Set(alerts.map(usageEpisodeKey)).size).toBe(2);
  });

  it('re-keys the episode when the vendor reset moves to the next window', () => {
    const before = detectUsageAlerts([snap({ sevenDay: { usedPct: 95, resetsAt: 'r1' } })], {
      thresholdPct: 10,
      now: NOW,
      activeProviderIds: ACTIVE,
    });
    const after = detectUsageAlerts([snap({ sevenDay: { usedPct: 95, resetsAt: 'r2' } })], {
      thresholdPct: 10,
      now: NOW,
      activeProviderIds: ACTIVE,
    });
    expect(usageEpisodeKey(before[0]!)).not.toBe(usageEpisodeKey(after[0]!));
  });

  it('buckets by window length when the vendor omits resetsAt (zai)', () => {
    // zai always reports resetsAt: null, so the episode falls back to a fixed-epoch
    // 5-hour bucket: stable within the bucket, fresh in the next one.
    const zai = snap({ providerName: 'zai', fiveHour: { usedPct: 97, resetsAt: null } });
    const opts = { thresholdPct: 10, now: NOW, activeProviderIds: ACTIVE };
    const first = detectUsageAlerts([zai], opts);
    const sameBucket = detectUsageAlerts([zai], { ...opts, now: NOW + 60_000 });
    const nextBucket = detectUsageAlerts([zai], { ...opts, now: NOW + WINDOW_MS.fiveHour });

    expect(usageEpisodeKey(first[0]!)).toBe(usageEpisodeKey(sameBucket[0]!));
    expect(usageEpisodeKey(first[0]!)).not.toBe(usageEpisodeKey(nextBucket[0]!));
  });

  it('scopes the episode to the allowance so two subscriptions never share a key', () => {
    const alerts = detectUsageAlerts(
      [
        snap({ providerId: 'p1', fiveHour: { usedPct: 95, resetsAt: null } }),
        snap({ providerId: 'p2', fiveHour: { usedPct: 95, resetsAt: null } }),
      ],
      {
        thresholdPct: 10,
        now: NOW,
        activeProviderIds: ACTIVE,
        allowanceKeys: { p1: 'provider:p1', p2: 'provider:p2' },
      },
    );
    expect(new Set(alerts.map(usageEpisodeKey)).size).toBe(2);
  });

  it('collapses the provider rows that share one subscription into a single alert', () => {
    // The reported case: four claude-code rows (Fable Low/Max/xHigh, Sonnet xHigh) all
    // mount the shared auth volume, so they are one Claude allowance reported four times.
    const rows = ['fable-low', 'fable-max', 'fable-xhigh', 'sonnet-xhigh'].map((id, i) =>
      snap({
        providerId: id,
        providerName: 'claude-code',
        // Each row stamps its own reset instant milliseconds apart, and their percentages
        // disagree by a point because they poll seconds apart.
        fiveHour: { usedPct: 89 + (i % 2), resetsAt: `2026-07-25T19:29:59.${320 + i}Z` },
      }),
    );
    const alerts = detectUsageAlerts(rows, {
      thresholdPct: 12,
      now: NOW,
      activeProviderIds: rows.map((r) => r.providerId),
      allowanceKeys: Object.fromEntries(rows.map((r) => [r.providerId, 'shared:claude-code'])),
    });
    expect(alerts).toHaveLength(1);
    // The most depleted reading wins, so collapsing never flatters the situation.
    expect(alerts[0]!.remainingPct).toBe(10);
  });

  it('keeps one alert when rows sharing a subscription straddle a minute boundary', () => {
    const rows = [
      snap({ providerId: 'a', fiveHour: { usedPct: 95, resetsAt: '2026-07-25T19:29:59.900Z' } }),
      snap({ providerId: 'b', fiveHour: { usedPct: 95, resetsAt: '2026-07-25T19:30:00.100Z' } }),
    ];
    const alerts = detectUsageAlerts(rows, {
      thresholdPct: 10,
      now: NOW,
      activeProviderIds: ['a', 'b'],
      allowanceKeys: { a: 'shared:codex', b: 'shared:codex' },
    });
    expect(alerts).toHaveLength(1);
  });

  it('falls back to per-provider keys when the api omits allowanceKeys', () => {
    const alerts = detectUsageAlerts(
      [
        snap({ providerId: 'p1', fiveHour: { usedPct: 95, resetsAt: null } }),
        snap({ providerId: 'p2', fiveHour: { usedPct: 95, resetsAt: null } }),
      ],
      { thresholdPct: 10, now: NOW, activeProviderIds: ACTIVE },
    );
    expect(alerts).toHaveLength(2);
  });

  it('re-keys the episode across a real window boundary despite minute flooring', () => {
    const at = (resetsAt: string) =>
      detectUsageAlerts([snap({ fiveHour: { usedPct: 95, resetsAt } })], {
        thresholdPct: 10,
        now: NOW,
        activeProviderIds: ACTIVE,
        allowanceKeys: { p1: 'shared:codex' },
      })[0]!;
    expect(usageEpisodeKey(at('2026-07-25T19:29:59.320Z'))).not.toBe(
      usageEpisodeKey(at('2026-07-26T00:29:59.320Z')),
    );
  });
});
