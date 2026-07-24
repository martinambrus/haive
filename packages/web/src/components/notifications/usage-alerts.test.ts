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

describe('detectUsageAlerts', () => {
  it('fires exactly at the threshold and stays quiet one point above it', () => {
    const at = detectUsageAlerts([snap({ sevenDay: { usedPct: 90, resetsAt: 'r1' } })], {
      thresholdPct: 10,
      now: NOW,
    });
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ windowKey: 'sevenDay', remainingPct: 10, occurrence: 'r1' });

    const above = detectUsageAlerts([snap({ sevenDay: { usedPct: 89, resetsAt: 'r1' } })], {
      thresholdPct: 10,
      now: NOW,
    });
    expect(above).toEqual([]);
  });

  it('skips stale, errored and reconnect-needing snapshots', () => {
    const depleted = { fiveHour: { usedPct: 99, resetsAt: 'r1' } };
    const opts = { thresholdPct: 10, now: NOW };
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
      { thresholdPct: 10, now: NOW },
    );
    expect(alerts.map((a) => a.windowKey)).toEqual(['fiveHour', 'sevenDay']);
    expect(new Set(alerts.map(usageEpisodeKey)).size).toBe(2);
  });

  it('re-keys the episode when the vendor reset moves to the next window', () => {
    const before = detectUsageAlerts([snap({ sevenDay: { usedPct: 95, resetsAt: 'r1' } })], {
      thresholdPct: 10,
      now: NOW,
    });
    const after = detectUsageAlerts([snap({ sevenDay: { usedPct: 95, resetsAt: 'r2' } })], {
      thresholdPct: 10,
      now: NOW,
    });
    expect(usageEpisodeKey(before[0]!)).not.toBe(usageEpisodeKey(after[0]!));
  });

  it('buckets by window length when the vendor omits resetsAt (zai)', () => {
    // zai always reports resetsAt: null, so the episode falls back to a fixed-epoch
    // 5-hour bucket: stable within the bucket, fresh in the next one.
    const zai = snap({ providerName: 'zai', fiveHour: { usedPct: 97, resetsAt: null } });
    const opts = { thresholdPct: 10, now: NOW };
    const first = detectUsageAlerts([zai], opts);
    const sameBucket = detectUsageAlerts([zai], { ...opts, now: NOW + 60_000 });
    const nextBucket = detectUsageAlerts([zai], { ...opts, now: NOW + WINDOW_MS.fiveHour });

    expect(usageEpisodeKey(first[0]!)).toBe(usageEpisodeKey(sameBucket[0]!));
    expect(usageEpisodeKey(first[0]!)).not.toBe(usageEpisodeKey(nextBucket[0]!));
  });

  it('scopes the episode to the provider so two CLIs never share a key', () => {
    const alerts = detectUsageAlerts(
      [
        snap({ providerId: 'p1', fiveHour: { usedPct: 95, resetsAt: null } }),
        snap({ providerId: 'p2', fiveHour: { usedPct: 95, resetsAt: null } }),
      ],
      { thresholdPct: 10, now: NOW },
    );
    expect(new Set(alerts.map(usageEpisodeKey)).size).toBe(2);
  });
});
