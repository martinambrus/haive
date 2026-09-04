import { describe, expect, it } from 'vitest';
import type { CliInvocationSummary } from '@/lib/api-client';
import {
  compareInvocationsDesc,
  invocationHistoryPaging,
  isInvocationExpanded,
  MAX_KEPT_OPEN_RUNS,
  mergeInvocationPage,
  rememberActiveRuns,
  trimInvocationWindow,
} from './invocation-history';

/** Minimal row: only the fields the merge and the expansion rule actually read. */
function inv(
  id: string,
  createdAt: string,
  opts: { active?: boolean; runNumber?: number } = {},
): CliInvocationSummary {
  return {
    id,
    mode: 'cli',
    exitCode: opts.active ? null : 0,
    durationMs: null,
    timeoutMs: null,
    startedAt: createdAt,
    endedAt: opts.active ? null : createdAt,
    createdAt,
    errorMessage: null,
    isActive: opts.active ?? false,
    providerLabel: null,
    providerName: null,
    agentTitle: null,
    statusMessage: null,
    tokenUsage: null,
    effort: null,
    runNumber: opts.runNumber ?? null,
  } as CliInvocationSummary;
}

const ids = (rows: CliInvocationSummary[]): string[] => rows.map((r) => r.id);

describe('compareInvocationsDesc', () => {
  it('orders newest-first and breaks ties on id, matching the api', () => {
    // created_at defaults to now() — the TRANSACTION timestamp — so a fan-out that inserts
    // its invocations together really does produce identical values.
    const rows = [inv('a', '2026-09-01T10:00:00Z'), inv('c', '2026-09-01T10:00:00Z')];
    expect(ids(rows.slice().sort(compareInvocationsDesc))).toEqual(['c', 'a']);
    expect(
      ids(
        [inv('a', '2026-09-01T10:00:00Z'), inv('b', '2026-09-02T10:00:00Z')].sort(
          compareInvocationsDesc,
        ),
      ),
    ).toEqual(['b', 'a']);
  });
});

describe('mergeInvocationPage — head refresh (the poll)', () => {
  it('keeps older pages the user loaded instead of discarding them', () => {
    const prev = [inv('r5', '2026-09-01T05:00:00Z'), inv('r4', '2026-09-01T04:00:00Z')];
    const page = [inv('r6', '2026-09-01T06:00:00Z'), inv('r5', '2026-09-01T05:00:00Z')];
    const out = mergeInvocationPage({ prev, page, limit: 2, append: false });
    expect(ids(out)).toEqual(['r6', 'r5', 'r4']);
  });

  it('drops a superseded row inside the page’s range', () => {
    // A retry supersedes rows, so the api stops returning them. Anything at or newer than
    // the page floor that the page did not carry is gone, not merely off this page.
    const prev = [inv('r6', '2026-09-01T06:00:00Z'), inv('r5', '2026-09-01T05:00:00Z')];
    const page = [inv('r6', '2026-09-01T06:00:00Z'), inv('r4', '2026-09-01T04:00:00Z')];
    const out = mergeInvocationPage({ prev, page, limit: 2, append: false });
    expect(ids(out)).toEqual(['r6', 'r4']);
  });

  it('a short page is authoritative for the whole step', () => {
    const prev = [inv('r3', '2026-09-01T03:00:00Z'), inv('r1', '2026-09-01T01:00:00Z')];
    const page = [inv('r3', '2026-09-01T03:00:00Z')];
    expect(ids(mergeInvocationPage({ prev, page, limit: 20, append: false }))).toEqual(['r3']);
  });

  it('replaces a held row with the page’s fresher copy', () => {
    const prev = [inv('r2', '2026-09-01T02:00:00Z', { active: true })];
    const page = [inv('r2', '2026-09-01T02:00:00Z')];
    const out = mergeInvocationPage({ prev, page, limit: 20, append: false });
    expect(out).toHaveLength(1);
    expect(out[0]?.isActive).toBe(false);
  });

  it('never leaves a stale running badge on a run the active set no longer names', () => {
    // The api returns EVERY active run, so a held active row missing from the page has
    // stopped being active. Dropping it beats rendering "running" forever; the next
    // "load older" page brings it back with its real exit code.
    const prev = [
      inv('r9', '2026-09-01T09:00:00Z'),
      inv('r1', '2026-09-01T01:00:00Z', { active: true }),
    ];
    const page = [inv('r9', '2026-09-01T09:00:00Z'), inv('r8', '2026-09-01T08:00:00Z')];
    const out = mergeInvocationPage({ prev, page, limit: 2, append: false });
    expect(ids(out)).toEqual(['r9', 'r8']);
  });

  it('does not duplicate a row that the page and the held set share', () => {
    const shared = inv('r7', '2026-09-01T07:00:00Z');
    const out = mergeInvocationPage({
      prev: [shared, inv('r6', '2026-09-01T06:00:00Z')],
      page: [shared],
      limit: 20,
      append: false,
    });
    expect(ids(out)).toEqual(['r7']);
  });

  it('keeps loaded history when the page carries no completed rows at all', () => {
    // historyLimit=0: the caller asked for active runs only, so it learned nothing about
    // history and must not throw away what it holds.
    const prev = [inv('r3', '2026-09-01T03:00:00Z')];
    const page = [inv('r4', '2026-09-01T04:00:00Z', { active: true })];
    expect(ids(mergeInvocationPage({ prev, page, limit: 0, append: false }))).toEqual(['r4', 'r3']);
  });
});

describe('mergeInvocationPage — appending an older page', () => {
  it('adds the older slice below without invalidating anything held', () => {
    const prev = [inv('r6', '2026-09-01T06:00:00Z'), inv('r5', '2026-09-01T05:00:00Z')];
    const page = [inv('r4', '2026-09-01T04:00:00Z'), inv('r3', '2026-09-01T03:00:00Z')];
    expect(ids(mergeInvocationPage({ prev, page, limit: 2, append: true }))).toEqual([
      'r6',
      'r5',
      'r4',
      'r3',
    ]);
  });

  it('dedupes an overlapping row rather than showing it twice', () => {
    const prev = [inv('r5', '2026-09-01T05:00:00Z')];
    const page = [inv('r5', '2026-09-01T05:00:00Z'), inv('r4', '2026-09-01T04:00:00Z')];
    expect(ids(mergeInvocationPage({ prev, page, limit: 2, append: true }))).toEqual(['r5', 'r4']);
  });
});

describe('trimInvocationWindow', () => {
  const wave = (n: number, from: number, opts: { active?: boolean } = {}) =>
    Array.from({ length: n }, (_, i) =>
      inv(`r${from + i}`, new Date(Date.UTC(2026, 8, 1, 0, from + i)).toISOString(), opts),
    ).sort(compareInvocationsDesc);

  it('keeps only the newest budgeted completed rows', () => {
    expect(ids(trimInvocationWindow(wave(5, 1), 3))).toEqual(['r5', 'r4', 'r3']);
  });

  it('is a no-op while the held set is inside the budget', () => {
    const rows = wave(3, 1);
    expect(trimInvocationWindow(rows, 20)).toEqual(rows);
  });

  it('never trims an ACTIVE run, however far down the ordering it sits', () => {
    // A long agent still going while its faster siblings started and finished: it is OLDER than
    // every completed row, and paging it away would drop a live terminal.
    const rows = [...wave(5, 10), ...wave(1, 1, { active: true })].sort(compareInvocationsDesc);
    expect(ids(trimInvocationWindow(rows, 2))).toEqual(['r14', 'r13', 'r1']);
  });

  it('bounds the window a poll can reach no matter how many waves ran', () => {
    // The leak, in one assertion: 48 waves of 12 used to leave all 576 rows held.
    let held: ReturnType<typeof wave> = [];
    for (let w = 0; w < 48; w++) {
      held = trimInvocationWindow(
        mergeInvocationPage({ prev: held, page: wave(12, w * 12), limit: 12, append: false }),
        20,
      );
    }
    expect(held).toHaveLength(20);
  });
});

describe('rememberActiveRuns', () => {
  it('keeps every id while under the cap', () => {
    const seen = new Set<string>();
    rememberActiveRuns(seen, ['a', 'b'], 4);
    rememberActiveRuns(seen, ['c'], 4);
    expect([...seen]).toEqual(['a', 'b', 'c']);
  });

  it('evicts the least recently active first', () => {
    const seen = new Set<string>();
    rememberActiveRuns(seen, ['a', 'b', 'c'], 3);
    rememberActiveRuns(seen, ['d'], 3);
    expect([...seen]).toEqual(['b', 'c', 'd']);
  });

  it('never evicts a run that is STILL active', () => {
    // 'a' is a long agent that outlives three waves of faster siblings. Re-seen on every poll,
    // it is re-inserted as the newest entry, so the eviction walks off the other end.
    const seen = new Set<string>();
    rememberActiveRuns(seen, ['a'], 3);
    for (const poll of [
      ['a', 'b'],
      ['a', 'c'],
      ['a', 'd'],
    ])
      rememberActiveRuns(seen, poll, 3);
    expect(seen.has('a')).toBe(true);
    // 'b' is the one evicted: recency is per CALL, and 'a' leads each poll's list, so it lands
    // ahead of that poll's newcomer while still outranking every earlier one.
    expect([...seen]).toEqual(['c', 'a', 'd']);
  });

  it('holds the mounted set flat across wave after wave', () => {
    const seen = new Set<string>();
    for (let w = 0; w < 48; w++) {
      rememberActiveRuns(
        seen,
        Array.from({ length: 12 }, (_, i) => `w${w}-${i}`),
      );
    }
    expect(seen.size).toBe(MAX_KEPT_OPEN_RUNS);
  });
});

describe('invocationHistoryPaging', () => {
  it('points the cursor at the oldest COMPLETED row held', () => {
    const rows = [
      inv('r9', '2026-09-01T09:00:00Z', { active: true }),
      inv('r8', '2026-09-01T08:00:00Z'),
      inv('r7', '2026-09-01T07:00:00Z'),
    ];
    expect(invocationHistoryPaging(rows, 50)).toEqual({ loaded: 2, remaining: 48, cursor: 'r7' });
  });

  it('offers no cursor once every completed run is held', () => {
    const rows = [inv('r2', '2026-09-01T02:00:00Z'), inv('r1', '2026-09-01T01:00:00Z')];
    expect(invocationHistoryPaging(rows, 2)).toEqual({ loaded: 2, remaining: 0, cursor: null });
  });

  it('never reports a negative remainder when a retry shrinks the step', () => {
    const rows = [inv('r2', '2026-09-01T02:00:00Z'), inv('r1', '2026-09-01T01:00:00Z')];
    expect(invocationHistoryPaging(rows, 1).remaining).toBe(0);
  });
});

describe('isInvocationExpanded', () => {
  const active = inv('a1', '2026-09-01T01:00:00Z', { active: true });
  const done = inv('d1', '2026-09-01T01:00:00Z');

  it('mounts live runs and leaves finished ones collapsed', () => {
    expect(isInvocationExpanded(active, {}, new Set())).toBe(true);
    expect(isInvocationExpanded(done, {}, new Set())).toBe(false);
  });

  it('keeps a run open once the user has watched it running', () => {
    expect(isInvocationExpanded(done, {}, new Set(['d1']))).toBe(true);
  });

  it('lets an explicit click win in both directions', () => {
    expect(isInvocationExpanded(active, { a1: false }, new Set(['a1']))).toBe(false);
    expect(isInvocationExpanded(done, { d1: true }, new Set())).toBe(true);
  });

  it('collapses a finished run once newer runs have pushed it out of the kept set', () => {
    const seen = new Set<string>();
    rememberActiveRuns(seen, ['d1'], 2);
    expect(isInvocationExpanded(done, {}, seen)).toBe(true);
    rememberActiveRuns(seen, ['n1', 'n2'], 2);
    expect(isInvocationExpanded(done, {}, seen)).toBe(false);
    // ...unless the user pinned it open, which outranks the eviction the same way it outranks
    // every other default.
    expect(isInvocationExpanded(done, { d1: true }, seen)).toBe(true);
  });

  it('mounts nothing for a page of history on a step with no live run', () => {
    const history = Array.from({ length: 500 }, (_, i) =>
      inv(`h${i}`, new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString()),
    );
    expect(history.filter((r) => isInvocationExpanded(r, {}, new Set()))).toHaveLength(0);
  });
});
