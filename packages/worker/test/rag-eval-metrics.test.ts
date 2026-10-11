import { describe, expect, it } from 'vitest';
import {
  fmtSummary,
  parseQuerySet,
  rankOfExpected,
  summarizeRanks,
} from '../scripts/rag-eval-metrics.js';

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

  it('is null for an empty expected, which every path would contain', () => {
    expect(rankOfExpected([{ sourcePath: 'a/x.ts' }], '')).toBeNull();
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

describe('parseQuerySet', () => {
  it('rejects an empty expected', () => {
    expect(() => parseQuerySet([{ query: 'q', expected: '' }], 'set.json')).toThrow(
      'set.json[0]: "expected" must not be empty',
    );
  });

  it('defaults kind to all', () => {
    expect(parseQuerySet([{ query: 'q', expected: 'x.ts' }], 's')).toEqual([
      { query: 'q', expected: 'x.ts', kind: 'all' },
    ]);
  });
});

describe('fmtSummary', () => {
  it('reports no cutoff deeper than topK', () => {
    expect(fmtSummary('all', [1, 3], 3)).toBe(
      'all              n=2 MRR@3=0.667 hit@1=1/2 hit@3=2/2',
    );
    expect(fmtSummary('all', [1], 1)).toBe('all              n=1 MRR@1=1.000 hit@1=1/1');
  });

  it('keeps hit@5 and hit@k for a deeper topK', () => {
    expect(fmtSummary('all', [1, 8], 10)).toBe(
      'all              n=2 MRR@10=0.563 hit@1=1/2 hit@5=1/2 hit@10=2/2',
    );
    expect(fmtSummary('all', [5], 5)).toBe('all              n=1 MRR@5=0.200 hit@1=0/1 hit@5=1/1');
  });
});
