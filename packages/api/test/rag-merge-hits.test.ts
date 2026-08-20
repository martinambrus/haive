import { describe, expect, it } from 'vitest';
import type { RagSearchHit } from '@haive/shared/rag';
import {
  dedupeGlobalByEntry,
  expandGlobalHits,
  mergeHits,
  type GlobalKbEntryBody,
} from '../src/routes/rag.js';

/** Descending-rrf hits from one store. rrf is the only field mergeHits reads. */
function hits(scope: 'local' | 'global', count: number, topRrf: number): RagSearchHit[] {
  return Array.from({ length: count }, (_, i) => ({
    sourcePath: `${scope}/file-${i}.ts`,
    sectionId: '',
    chunkIndex: 0,
    sourceType: scope === 'global' ? 'kb' : 'code',
    content: '',
    denseSim: 0,
    tsNorm: 0,
    hybrid: 0,
    rrf: topRrf - i * 0.001,
    scope,
  }));
}

const scopes = (merged: RagSearchHit[]): string =>
  merged.map((h) => (h.scope === 'global' ? 'g' : 'l')).join('');

describe('mergeHits', () => {
  it('fills the whole topK from global when the local index is not built', () => {
    // The un-indexed-repo case: the global reserve is a floor for global, not a
    // ceiling, so all 8 slots go to global rather than only floor(8/2)=4.
    const merged = mergeHits([], hits('global', 20, 0.05), 8);
    expect(merged).toHaveLength(8);
    expect(scopes(merged)).toBe('gggggggg');
  });

  it('fills the whole topK from local when the global KB is empty', () => {
    const merged = mergeHits(hits('local', 20, 0.05), [], 8);
    expect(merged).toHaveLength(8);
    expect(scopes(merged)).toBe('llllllll');
  });

  it('keeps the reserved half-and-half split when both stores are full', () => {
    const merged = mergeHits(hits('local', 20, 0.05), hits('global', 20, 0.04), 8);
    expect(merged).toHaveLength(8);
    expect(merged.filter((h) => h.scope === 'global')).toHaveLength(4);
    expect(merged.filter((h) => h.scope === 'local')).toHaveLength(4);
  });

  it('lets local take the slots a short global store leaves free', () => {
    const merged = mergeHits(hits('local', 20, 0.05), hits('global', 1, 0.04), 8);
    expect(merged).toHaveLength(8);
    expect(merged.filter((h) => h.scope === 'global')).toHaveLength(1);
  });

  it('tops global up past its reserve only with slots local left free', () => {
    const merged = mergeHits(hits('local', 2, 0.05), hits('global', 20, 0.04), 8);
    expect(merged).toHaveLength(8);
    expect(merged.filter((h) => h.scope === 'local')).toHaveLength(2);
    expect(merged.filter((h) => h.scope === 'global')).toHaveLength(6);
  });

  it('returns fewer than topK when both stores together cannot fill it', () => {
    const merged = mergeHits(hits('local', 2, 0.05), hits('global', 1, 0.04), 8);
    expect(merged).toHaveLength(3);
  });

  it('sorts the merged page by rrf descending', () => {
    const merged = mergeHits(hits('local', 4, 0.03), hits('global', 4, 0.09), 8);
    const rrfs = merged.map((h) => h.rrf);
    expect(rrfs).toEqual([...rrfs].sort((a, b) => b - a));
    // Global outranks local here, so it must lead despite the reserve ordering.
    expect(merged[0]?.scope).toBe('global');
  });

  it('does not mutate either input array', () => {
    const local = hits('local', 5, 0.01);
    const global = hits('global', 5, 0.09);
    const localOrder = local.map((h) => h.sourcePath);
    const globalOrder = global.map((h) => h.sourcePath);
    mergeHits(local, global, 8);
    expect(local.map((h) => h.sourcePath)).toEqual(localOrder);
    expect(global.map((h) => h.sourcePath)).toEqual(globalOrder);
    expect(local).toHaveLength(5);
    expect(global).toHaveLength(5);
  });
});

/** One hit, spelled out — these tests care about sourcePath/content, which the
 *  `hits()` helper above leaves generic. */
function hit(over: Partial<RagSearchHit> & Pick<RagSearchHit, 'sourcePath' | 'rrf'>): RagSearchHit {
  return {
    sectionId: 'sec',
    chunkIndex: 0,
    sourceType: 'kb',
    content: 'chunk text',
    denseSim: 0,
    tsNorm: 0,
    hybrid: 0,
    scope: 'global',
    ...over,
  };
}

describe('dedupeGlobalByEntry', () => {
  it("keeps one hit per entry — the entry's best-scoring chunk", () => {
    const deduped = dedupeGlobalByEntry([
      hit({ sourcePath: 'global_kb/a.md', sectionId: 'weak', rrf: 0.01 }),
      hit({ sourcePath: 'global_kb/a.md', sectionId: 'best', rrf: 0.03 }),
      hit({ sourcePath: 'global_kb/b.md', sectionId: 'only', rrf: 0.02 }),
    ]);

    expect(deduped.map((h) => h.sourcePath)).toEqual(['global_kb/a.md', 'global_kb/b.md']);
    expect(deduped[0]?.sectionId).toBe('best');
  });

  it('orders the surviving entries by rrf descending', () => {
    const deduped = dedupeGlobalByEntry([
      hit({ sourcePath: 'global_kb/low.md', rrf: 0.01 }),
      hit({ sourcePath: 'global_kb/high.md', rrf: 0.09 }),
    ]);

    expect(deduped.map((h) => h.sourcePath)).toEqual(['global_kb/high.md', 'global_kb/low.md']);
  });

  it('does not mutate its input', () => {
    const input = [
      hit({ sourcePath: 'global_kb/a.md', rrf: 0.01 }),
      hit({ sourcePath: 'global_kb/a.md', rrf: 0.03 }),
    ];
    dedupeGlobalByEntry(input);
    expect(input).toHaveLength(2);
    expect(input[0]?.rrf).toBe(0.01);
  });
});

describe('expandGlobalHits', () => {
  const bodies = (entries: Record<string, GlobalKbEntryBody>): Map<string, GlobalKbEntryBody> =>
    new Map(Object.entries(entries));

  it('replaces a global chunk with the whole entry and drops the section anchor', () => {
    const [expanded] = expandGlobalHits(
      [hit({ sourcePath: 'global_kb/a.md', rrf: 0.03 })],
      bodies({ 'global_kb/a.md': { title: 'House rule', body: 'the whole article' } }),
    );

    expect(expanded?.content).toBe('[House rule — FULL ENTRY]\n\nthe whole article');
    // A whole-entry hit anchors to no single section, and the MCP proxy renders
    // '#<sectionId>' only when it is set.
    expect(expanded?.sectionId).toBe('');
  });

  it('leaves local hits alone', () => {
    const local = hit({ sourcePath: 'src/app.ts', rrf: 0.03, scope: 'local' });
    const [out] = expandGlobalHits([local], bodies({ 'src/app.ts': { title: 'x', body: 'y' } }));

    expect(out).toEqual(local);
  });

  it('leaves a global hit whose entry body was not fetched untouched', () => {
    const orphan = hit({ sourcePath: 'global_kb/missing.md', rrf: 0.03 });
    const [out] = expandGlobalHits([orphan], bodies({}));

    expect(out).toEqual(orphan);
  });

  it('labels an over-budget entry a snippet instead of passing it off as whole', () => {
    const out = expandGlobalHits(
      [
        hit({ sourcePath: 'global_kb/small.md', rrf: 0.09 }),
        hit({ sourcePath: 'global_kb/big.md', rrf: 0.03, content: 'one section' }),
      ],
      bodies({
        'global_kb/small.md': { title: 'Small', body: 'short' },
        'global_kb/big.md': { title: 'Big', body: 'x'.repeat(500) },
      }),
      100,
    );

    expect(out[1]?.content).toContain('one section');
    expect(out[1]?.content).toContain('SNIPPET ONLY');
    expect(out[1]?.content).toContain('500-char entry');
    expect(out[1]?.sectionId).toBe('sec');
  });

  it('expands the best entry even when it alone exceeds the whole budget', () => {
    // The corpus holds a body larger than the budget. Budgeting the top hit too
    // would make those entries permanently unreadable, which is the failure this
    // path exists to fix.
    const [out] = expandGlobalHits(
      [hit({ sourcePath: 'global_kb/huge.md', rrf: 0.09 })],
      bodies({ 'global_kb/huge.md': { title: 'Huge', body: 'x'.repeat(500) } }),
      100,
    );

    expect(out?.content).toContain('FULL ENTRY');
    expect(out?.content).toContain('x'.repeat(500));
  });

  it('spends the budget in the order it is given, so the best hit expands first', () => {
    const out = expandGlobalHits(
      [
        hit({ sourcePath: 'global_kb/first.md', rrf: 0.09 }),
        hit({ sourcePath: 'global_kb/second.md', rrf: 0.01 }),
      ],
      bodies({
        'global_kb/first.md': { title: 'First', body: 'a'.repeat(60) },
        'global_kb/second.md': { title: 'Second', body: 'b'.repeat(60) },
      }),
      100,
    );

    expect(out[0]?.content).toContain('FULL ENTRY');
    expect(out[1]?.content).toContain('SNIPPET ONLY');
  });

  it('does not mutate its input hits', () => {
    const input = [hit({ sourcePath: 'global_kb/a.md', rrf: 0.03 })];
    expandGlobalHits(input, bodies({ 'global_kb/a.md': { title: 'T', body: 'B' } }));

    expect(input[0]?.content).toBe('chunk text');
    expect(input[0]?.sectionId).toBe('sec');
  });
});
