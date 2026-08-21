import { describe, it, expect } from 'vitest';
import type { Database } from '@haive/database';
import {
  augmentPromptWithLedger,
  cleanText,
  contentFingerprint,
  loadLedgerEntries,
  recordLedgerEntry,
  type LedgerEntry,
} from './task-ledger.js';

type StoredPayload = LedgerEntry & { fingerprint?: string };

/** Mimics the drizzle chain loadLedgerEntries uses: select().from().where().orderBy(). */
function mockDb(
  rows: Array<{ payload: StoredPayload | null; taskStepId?: string | null }>,
  opts: { throws?: boolean } = {},
) {
  const inserted: unknown[] = [];
  const orderBy = opts.throws
    ? () => {
        throw new Error('db down');
      }
    : async () => rows;
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy }) }) }),
    insert: () => ({
      values: async (v: unknown) => {
        if (opts.throws) throw new Error('db down');
        inserted.push(v);
      },
    }),
  } as unknown as Database;
  return { db, inserted };
}

const entry = (text: string, over: Partial<StoredPayload> = {}): { payload: StoredPayload } => ({
  payload: { stepId: '07-phase-2-implement', round: 0, text, ...over },
});

describe('cleanText', () => {
  it('strips ANSI and collapses blank runs but keeps the content', () => {
    const out = cleanText('a\x1B[31mb\x1B[0m  \n\n\n\nc', 6000);
    expect(out).toBe('ab\n\nc');
  });

  it('keeps the TAIL when over the limit — CLI errors put the summary last', () => {
    expect(cleanText('abcdefghij', 4)).toBe('ghij');
  });
});

describe('contentFingerprint', () => {
  it('collapses texts differing only in ids, paths and numbers', () => {
    const a = contentFingerprint('s', 'failed at /var/www/app.php line 42');
    const b = contentFingerprint('s', 'failed at /srv/other/thing.php line 7');
    expect(a).toBe(b);
  });

  it('keeps genuinely different texts distinct', () => {
    expect(contentFingerprint('s', 'no composer')).not.toBe(contentFingerprint('s', 'no npm'));
  });

  it('namespaces by scope so two steps never collide', () => {
    expect(contentFingerprint('a', 'same')).not.toBe(contentFingerprint('b', 'same'));
  });
});

describe('recordLedgerEntry', () => {
  it('skips empty text without touching the db', async () => {
    const { db, inserted } = mockDb([]);
    await recordLedgerEntry(db, 't1', 's1', { stepId: '07', round: 0, text: '   ' });
    expect(inserted).toHaveLength(0);
  });

  it('stores the fingerprint alongside the entry', async () => {
    const { db, inserted } = mockDb([]);
    await recordLedgerEntry(db, 't1', 's1', { stepId: '07', round: 1, text: ' ddev absent ' });
    expect(inserted).toHaveLength(1);
    const v = inserted[0] as { payload: StoredPayload; eventType: string };
    expect(v.eventType).toBe('ledger.entry');
    expect(v.payload.text).toBe('ddev absent');
    expect(v.payload.fingerprint).toBe(contentFingerprint('07', 'ddev absent'));
  });

  it('never throws when the insert fails', async () => {
    const { db } = mockDb([], { throws: true });
    await expect(
      recordLedgerEntry(db, 't1', 's1', { stepId: '07', round: 0, text: 'x' }),
    ).resolves.toBeUndefined();
  });
});

describe('loadLedgerEntries', () => {
  it('collapses duplicates, keeping the first occurrence', async () => {
    const { db } = mockDb([
      entry('no composer on PATH', { round: 0 }),
      entry('no composer on PATH', { round: 2 }),
      entry('vitest is the test runner', { round: 1 }),
    ]);
    const out = await loadLedgerEntries(db, 't1');
    expect(out.map((e) => e.text)).toEqual(['no composer on PATH', 'vitest is the test runner']);
    expect(out[0]!.round).toBe(0);
  });

  it('drops malformed and empty rows', async () => {
    const { db } = mockDb([
      { payload: null },
      entry(''),
      { payload: { round: 0, text: 'orphan' } as StoredPayload },
      entry('real'),
    ]);
    expect(await loadLedgerEntries(db, 't1')).toHaveLength(1);
  });

  it('defaults kind to finding', async () => {
    const { db } = mockDb([entry('a'), entry('b', { kind: 'change' })]);
    const out = await loadLedgerEntries(db, 't1');
    expect(out.map((e) => e.kind)).toEqual(['finding', 'change']);
  });
});

describe('augmentPromptWithLedger', () => {
  it('returns the prompt unchanged when the ledger is empty', async () => {
    const { db } = mockDb([]);
    expect(await augmentPromptWithLedger(db, 't1', 'ORIGINAL')).toBe('ORIGINAL');
  });

  it('returns the prompt unchanged when the lookup throws', async () => {
    const { db } = mockDb([], { throws: true });
    expect(await augmentPromptWithLedger(db, 't1', 'ORIGINAL')).toBe('ORIGINAL');
  });

  it('prepends the entries and keeps the original prompt at the tail', async () => {
    const { db } = mockDb([entry('ddev is not on PATH', { round: 1 })]);
    const out = await augmentPromptWithLedger(db, 't1', 'ORIGINAL');
    expect(out).toContain('What earlier steps on this task already established');
    expect(out).toContain('- 07-phase-2-implement (round 1): ddev is not on PATH');
    expect(out.endsWith('ORIGINAL')).toBe(true);
  });

  it('drops WHOLE oldest entries when over budget, never splitting one', async () => {
    // Distinct WORDS, not digits: the fingerprint strips numbers, so `fact 0` and
    // `fact 5` would dedupe to one entry. Each is ~1.2k chars, so a 4k target cannot
    // hold all six.
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const rows = names.map((n, i) => entry(`fact ${n} ${'x'.repeat(1200)}`, { round: i }));
    const { db } = mockDb(rows);
    const out = await augmentPromptWithLedger(db, 't1', 'ORIGINAL');

    // The newest survive; the oldest are gone entirely rather than truncated.
    expect(out).toContain('fact foxtrot');
    expect(out).not.toContain('fact alpha');
    // Every surviving entry is whole — none was cut mid-line.
    for (const line of out.split('\n').filter((l) => l.startsWith('- '))) {
      expect(line).toContain('x'.repeat(1200));
    }
  });

  it('treats entries differing only by a number as one, matching the fix-loop rule', async () => {
    const { db } = mockDb([entry('port 8080 is taken'), entry('port 9090 is taken')]);
    const out = await augmentPromptWithLedger(db, 't1', 'P');
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
  });

  it('prefers a step summary over the raw entries it covers when over budget', async () => {
    const big = 'z'.repeat(1500);
    const rows = [
      { payload: { stepId: '08c', round: 0, text: `raw one ${big}` }, taskStepId: 'step-a' },
      { payload: { stepId: '08c', round: 0, text: `raw two ${big}` }, taskStepId: 'step-a' },
      {
        payload: { stepId: '08c', round: 0, text: 'the recap', kind: 'summary' },
        taskStepId: 'step-a',
      },
      { payload: { stepId: '08d', round: 0, text: `other ${big}` }, taskStepId: 'step-b' },
    ];
    const { db } = mockDb(rows as never);
    const out = await augmentPromptWithLedger(db, 't1', 'ORIGINAL');

    // step-a's two raw entries collapse into its summary; step-b has no summary so it stays.
    expect(out).toContain('the recap');
    expect(out).not.toContain('raw one');
    expect(out).not.toContain('raw two');
    expect(out).toContain('other');
  });

  it('does not repeat a fact the prompt already renders itself', async () => {
    const { db } = mockDb([entry('ddev is not on PATH')]);
    const prompt = 'PRIOR CONTEXT: ddev is not on PATH\n\nDo the work.';
    expect(await augmentPromptWithLedger(db, 't1', prompt)).toBe(prompt);
  });

  it('still injects the entries the prompt does not already carry', async () => {
    const { db } = mockDb([entry('already here'), entry('brand new fact')]);
    const out = await augmentPromptWithLedger(db, 't1', 'already here — do the work');
    expect(out).toContain('brand new fact');
    expect(out.split('already here').length - 1).toBe(1);
  });

  it('keeps at least one entry even when a single entry blows the budget', async () => {
    const { db } = mockDb([entry('y'.repeat(20_000))]);
    const out = await augmentPromptWithLedger(db, 't1', 'ORIGINAL');
    expect(out).toContain('y'.repeat(20_000));
  });
});
