import { describe, expect, it } from 'vitest';
import { rankOfExpected, summarizeRanks } from '../scripts/rag-eval-metrics.js';

describe('rankOfExpected', () => {
  it('is the 1-based rank of the first source path holding the substring', () => {
    const hits = [{ sourcePath: 'a/x.ts' }, { sourcePath: 'b/y.ts' }, { sourcePath: 'c/y.ts' }];
    expect(rankOfExpected(hits, 'y.ts')).toBe(2);
    expect(rankOfExpected(hits, 'a/')).toBe(1);
  });

  it('is null when nothing matches', () => {
    expect(rankOfExpected([{ sourcePath: 'a/x.ts' }], 'zzz')).toBeNull();
    expect(rankOfExpected([], 'x')).toBeNull();
  });
});

describe('summarizeRanks', () => {
  it('computes MRR and hit@1, hit@5, hit@k from known ranks', () => {
    const s = summarizeRanks([1, 2, 5, 8, null], 10);
    expect(s.n).toBe(5);
    expect(s.mrr).toBeCloseTo((1 + 1 / 2 + 1 / 5 + 1 / 8 + 0) / 5, 10);
    expect(s.hit1).toBe(1);
    expect(s.hit5).toBe(3);
    expect(s.hitK).toBe(4);
  });

  it('counts a rank beyond k as a miss', () => {
    const s = summarizeRanks([3, 9], 5);
    expect(s.mrr).toBeCloseTo(1 / 3 / 2, 10);
    expect(s.hitK).toBe(1);
    expect(s.hit5).toBe(1);
  });

  it('is all zero for an empty set', () => {
    expect(summarizeRanks([], 10)).toEqual({ n: 0, mrr: 0, hit1: 0, hit5: 0, hitK: 0 });
  });
});
