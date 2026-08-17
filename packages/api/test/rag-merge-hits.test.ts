import { describe, expect, it } from 'vitest';
import type { RagSearchHit } from '@haive/shared/rag';
import { mergeHits } from '../src/routes/rag.js';

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
