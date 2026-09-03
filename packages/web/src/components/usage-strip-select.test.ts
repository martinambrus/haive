import { describe, expect, it } from 'vitest';
import type { Task, UsageWindowSnapshot } from '@/lib/api-client';
import { selectMetersForProviderIds, selectStripMeters } from './usage-strip-select';

/** A listing row. `currentStepCliProviderIds` omitted = an older api that sends only the
 *  task column, which is the fallback path. */
const task = (cliProviderId: string | null, currentStepCliProviderIds?: string[]): Task =>
  ({ id: 'x', cliProviderId, currentStepCliProviderIds }) as Task;

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

  it('prompts a reconnect when a visible subscription has nothing readable left', () => {
    // The codex incident: every row on the subscription carries a dead token, so without
    // this the strip renders nothing at all and the user gets no signal.
    const meters = selectStripMeters(
      [task('x1')],
      [snap({ providerId: 'x1', providerName: 'codex', status: 'needs_reconnect' })],
      KEYS,
    );
    expect(meters).toHaveLength(1);
    expect(meters[0]!.status).toBe('needs_reconnect');
    expect(meters[0]!.allowanceKey).toBe('shared:codex');
  });

  it('picks the same dead row on every poll regardless of snapshot order', () => {
    const dead = (providerId: string) =>
      snap({ providerId, providerName: 'codex', status: 'needs_reconnect' });
    const forward = selectStripMeters([task('x1')], [dead('x1'), dead('x0')], {
      x0: 'shared:codex',
      x1: 'shared:codex',
    });
    const reversed = selectStripMeters([task('x1')], [dead('x0'), dead('x1')], {
      x0: 'shared:codex',
      x1: 'shared:codex',
    });
    expect(forward[0]!.snapshot.providerId).toBe('x0');
    expect(reversed[0]!.snapshot.providerId).toBe('x0');
  });

  it('prefers a live reading over a reconnect prompt on the same subscription', () => {
    const meters = selectStripMeters(
      [task('c1')],
      [
        snap({ providerId: 'c1', status: 'needs_reconnect' }),
        snap({ providerId: 'c2', fiveHour: { usedPct: 92, resetsAt: null } }),
      ],
      KEYS,
    );
    expect(meters).toHaveLength(1);
    expect(meters[0]!.status).toBe('ok');
    expect(meters[0]!.snapshot.providerId).toBe('c2');
  });

  it('says it is waiting once the credential has been repaired', () => {
    const meters = selectStripMeters(
      [task('x1')],
      [snap({ providerId: 'x1', providerName: 'codex', status: 'pending' })],
      KEYS,
    );
    expect(meters).toHaveLength(1);
    expect(meters[0]!.status).toBe('pending');
  });

  it('never asks for a reconnect that is already in flight on the same subscription', () => {
    // The trap this exists for: the user reconnects, the poller has not ticked, and a sibling
    // row still reads needs_reconnect — so the page tells them to redo a fix that worked.
    const meters = selectStripMeters(
      [task('x1')],
      [
        snap({ providerId: 'x1', providerName: 'codex', status: 'needs_reconnect' }),
        snap({ providerId: 'x2', providerName: 'codex', status: 'pending' }),
      ],
      { x1: 'shared:codex', x2: 'shared:codex' },
    );
    expect(meters).toHaveLength(1);
    expect(meters[0]!.status).toBe('pending');
  });

  it('prefers a live reading over a pending one', () => {
    const meters = selectStripMeters(
      [task('x1')],
      [
        snap({ providerId: 'x1', providerName: 'codex', status: 'pending' }),
        snap({
          providerId: 'x2',
          providerName: 'codex',
          sevenDay: { usedPct: 40, resetsAt: null },
        }),
      ],
      { x1: 'shared:codex', x2: 'shared:codex' },
    );
    expect(meters).toHaveLength(1);
    expect(meters[0]!.status).toBe('ok');
  });

  it('stays silent for a plain error — nothing to show and nothing to act on', () => {
    expect(
      selectStripMeters(
        [task('x1')],
        [snap({ providerId: 'x1', providerName: 'codex', status: 'error' })],
        KEYS,
      ),
    ).toEqual([]);
  });

  it('meters what the current step runs on, not the task column', () => {
    // The bug this exists for: both listed tasks named an ollama fixture as their task
    // provider (no meter of its own) while every invocation they had run went to codex and
    // claude-code, so the strip resolved an allowance nothing spends and drew nothing.
    const meters = selectStripMeters([task('ollama', ['x1'])], [...CLAUDE, CODEX], KEYS);
    expect(meters.map((m) => m.allowanceKey)).toEqual(['shared:codex']);
  });

  it('meters every seat of a fan-out step, not just its default', () => {
    const meters = selectStripMeters([task('ollama', ['c1', 'x1'])], [...CLAUDE, CODEX], KEYS);
    expect(meters.map((m) => m.allowanceKey)).toEqual(['shared:claude-code', 'shared:codex']);
  });

  it('shows nothing for a row that resolves to no usable provider', () => {
    // An empty array is an ANSWER (the task names no enabled CLI), not a missing field, so it
    // must not fall through to the task column.
    expect(selectStripMeters([task('c1', [])], CLAUDE, KEYS)).toEqual([]);
  });

  it('falls back to per-provider keys when the api omits allowanceKeys', () => {
    const meters = selectStripMeters([task('c1'), task('c2')], CLAUDE, undefined);
    expect(meters.map((m) => m.allowanceKey)).toEqual(['provider:c1', 'provider:c2']);
  });
});

describe('selectMetersForProviderIds', () => {
  it('collapses seats sharing a subscription into one meter', () => {
    // 08c with three seats pointed at three rows of the same Claude login: one meter, not
    // three copies of the same number sitting beside each other in the header.
    const meters = selectMetersForProviderIds(['c1', 'c2', 'c3'], CLAUDE, KEYS);
    expect(meters).toHaveLength(1);
    expect(meters[0]!.allowanceKey).toBe('shared:claude-code');
  });

  it('absorbs duplicate and null ids from unset seats', () => {
    const meters = selectMetersForProviderIds(['c1', null, 'c1', null], CLAUDE, KEYS);
    expect(meters).toHaveLength(1);
  });

  it('shows one meter per distinct subscription the step spends', () => {
    const meters = selectMetersForProviderIds(['c1', 'x1'], [...CLAUDE, CODEX], KEYS);
    expect(meters.map((m) => m.allowanceKey)).toEqual(['shared:claude-code', 'shared:codex']);
  });

  it('ignores an id with no snapshot of its own', () => {
    // An unmetered CLI (ollama, grok) has no row at all; the header names that separately
    // via resolveUsageChipState rather than here.
    expect(selectMetersForProviderIds(['nope'], CLAUDE, KEYS)).toEqual([]);
  });

  it('renders nothing for an empty set or unloaded snapshots', () => {
    expect(selectMetersForProviderIds([], CLAUDE, KEYS)).toEqual([]);
    expect(selectMetersForProviderIds(['c1'], null, KEYS)).toEqual([]);
  });
});
