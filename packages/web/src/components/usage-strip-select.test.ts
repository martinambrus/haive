import { describe, expect, it } from 'vitest';
import type { Task, UsageWindowSnapshot } from '@/lib/api-client';
import { selectStripMeters } from './usage-strip-select';

const task = (cliProviderId: string | null): Task => ({ id: 'x', cliProviderId }) as Task;

const snap = (over: Partial<UsageWindowSnapshot> = {}): UsageWindowSnapshot => ({
  providerId: 'p1',
  providerName: 'claude-code',
  fetchedAt: '2026-07-25T18:00:00.000Z',
  stale: false,
  status: 'ok',
  ...over,
});

/** Four claude rows on one login, one codex row on its own. */
const KEYS = {
  c1: 'shared:claude-code',
  c2: 'shared:claude-code',
  c3: 'shared:claude-code',
  x1: 'shared:codex',
};

const CLAUDE = [
  snap({ providerId: 'c1', fiveHour: { usedPct: 89, resetsAt: null } }),
  snap({ providerId: 'c2', fiveHour: { usedPct: 92, resetsAt: null } }),
  snap({ providerId: 'c3', fiveHour: { usedPct: 90, resetsAt: null } }),
];
const CODEX = snap({
  providerId: 'x1',
  providerName: 'codex',
  sevenDay: { usedPct: 100, resetsAt: null },
});

describe('selectStripMeters', () => {
  it('shows one meter per subscription, not per provider row', () => {
    const meters = selectStripMeters([task('c1'), task('c2'), task('c3')], CLAUDE, KEYS);
    expect(meters).toHaveLength(1);
    expect(meters[0]!.allowanceKey).toBe('shared:claude-code');
  });

  it('picks the most depleted row as the subscription representative', () => {
    const meters = selectStripMeters([task('c1')], CLAUDE, KEYS);
    // c2 is the worst at 92% used, and it speaks for the shared login even though the
    // visible task points at c1.
    expect(meters[0]!.snapshot.providerId).toBe('c2');
  });

  it('shows a meter per distinct subscription the visible rows use', () => {
    const meters = selectStripMeters([task('c1'), task('x1')], [...CLAUDE, CODEX], KEYS);
    expect(meters.map((m) => m.allowanceKey)).toEqual(['shared:claude-code', 'shared:codex']);
  });

  it('drops a subscription no visible row uses (the current filter narrows the strip)', () => {
    const meters = selectStripMeters([task('x1')], [...CLAUDE, CODEX], KEYS);
    expect(meters.map((m) => m.allowanceKey)).toEqual(['shared:codex']);
  });

  it('renders nothing for an empty or unloaded list', () => {
    expect(selectStripMeters([], CLAUDE, KEYS)).toEqual([]);
    expect(selectStripMeters(null, CLAUDE, KEYS)).toEqual([]);
    expect(selectStripMeters([task('c1')], null, KEYS)).toEqual([]);
  });

  it('ignores tasks with no CLI assigned', () => {
    expect(selectStripMeters([task(null)], CLAUDE, KEYS)).toEqual([]);
  });

  it('skips unreadable snapshots but keeps a healthy sibling on the same subscription', () => {
    const meters = selectStripMeters(
      [task('c1')],
      [
        snap({
          providerId: 'c1',
          status: 'needs_reconnect',
          fiveHour: { usedPct: 5, resetsAt: null },
        }),
        snap({ providerId: 'c2', fiveHour: { usedPct: 92, resetsAt: null } }),
      ],
      KEYS,
    );
    expect(meters).toHaveLength(1);
    expect(meters[0]!.snapshot.providerId).toBe('c2');
  });

  it('keeps a stale snapshot (the meter dims it rather than hiding it)', () => {
    const meters = selectStripMeters(
      [task('c1')],
      [snap({ providerId: 'c1', stale: true, fiveHour: { usedPct: 92, resetsAt: null } })],
      KEYS,
    );
    expect(meters).toHaveLength(1);
    expect(meters[0]!.snapshot.stale).toBe(true);
  });

  it('falls back to per-provider keys when the api omits allowanceKeys', () => {
    const meters = selectStripMeters([task('c1'), task('c2')], CLAUDE, undefined);
    expect(meters.map((m) => m.allowanceKey)).toEqual(['provider:c1', 'provider:c2']);
  });
});
