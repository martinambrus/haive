import { describe, expect, it } from 'vitest';
import {
  chunkBody,
  goldRank,
  parseQuerySet,
  percentile,
  rankOfExpected,
  scoreQuery,
  summarizeScores,
} from '../scripts/rag-eval-metrics.js';
import { checkDensePool } from '../scripts/rag-eval-dense.js';

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

describe('parseQuerySet', () => {
  it('rejects an empty expected', () => {
    expect(() => parseQuerySet([{ query: 'q', expected: '' }], 'set.json')).toThrow(
      'set.json[0]: "query" and "expected" must not be empty',
    );
  });

  it('rejects an empty or blank query', () => {
    for (const query of ['', '  ']) {
      expect(() => parseQuerySet([{ query, expected: 'x.ts' }], 'set.json')).toThrow(
        'set.json[0]: "query" and "expected" must not be empty',
      );
    }
  });

  it('defaults kind to all', () => {
    expect(parseQuerySet([{ query: 'q', expected: 'x.ts' }], 's')).toEqual([
      { query: 'q', expected: 'x.ts', kind: 'all' },
    ]);
  });
});

describe('chunkBody', () => {
  it('is the content after its context header line', () => {
    expect(chunkBody('[a.ts > f]\n\nfunction f() {}', 'a.ts')).toBe('\nfunction f() {}');
    expect(chunkBody('[a.ts]', 'a.ts')).toBe('');
  });

  it('is the whole content of a chunk with no header', () => {
    expect(chunkBody('function f() {}\nreturn 1;', 'a.ts')).toBe('function f() {}\nreturn 1;');
    expect(chunkBody('[$x, $y] = f();\nreturn 1;', 'a.ts')).toBe('[$x, $y] = f();\nreturn 1;');
  });
});

describe('goldRank', () => {
  const hit = (sourcePath: string, body: string) => ({
    sourcePath,
    content: `[${sourcePath} > x]\n${body}`,
  });

  it('matches on the exact path and an anchor in the body', () => {
    const hits = [hit('a.ts', 'nothing'), hit('b.ts', 'has fooBar here')];
    expect(goldRank(hits, { path: 'b.ts', anchor: 'fooBar' })).toBe(2);
    expect(goldRank(hits, { path: 'a.ts', anchor: 'fooBar' })).toBeNull();
  });

  it('does not match a path that merely contains the gold path', () => {
    expect(goldRank([hit('foo.inc.bak', 'x')], { path: 'foo.inc', anchor: 'x' })).toBeNull();
  });

  it('does not match an anchor that is only in the header line', () => {
    const hits = [{ sourcePath: 'a.ts', content: '[a.ts > fooBar]\nbody without it' }];
    expect(goldRank(hits, { path: 'a.ts', anchor: 'fooBar' })).toBeNull();
  });

  it('takes the best rank when two chunks hold the anchor', () => {
    const hits = [hit('a.ts', 'x'), hit('a.ts', 'x'), hit('a.ts', 'dup'), hit('a.ts', 'dup')];
    expect(goldRank(hits, { path: 'a.ts', anchor: 'dup' })).toBe(3);
  });
});

describe('scoreQuery', () => {
  it('scores recall and MRR at k from golds at ranks 2 and 7', () => {
    const outcomes = [
      { rank: 2, inStore: true },
      { rank: 7, inStore: true },
    ];
    expect(scoreQuery(outcomes, 5)).toEqual({ recall: 0.5, mrr: 0.5, hit: true });
    expect(scoreQuery(outcomes, 8)).toEqual({ recall: 1, mrr: 0.5, hit: true });
    expect(scoreQuery(outcomes, 1)).toEqual({ recall: 0, mrr: 0, hit: false });
  });

  it('leaves a gold that is not in the store out of the denominator', () => {
    const outcomes = [
      { rank: 3, inStore: true },
      { rank: null, inStore: false },
    ];
    expect(scoreQuery(outcomes, 5)).toEqual({ recall: 1, mrr: 1 / 3, hit: true });
  });

  it('is null when no gold is in the store', () => {
    expect(scoreQuery([{ rank: null, inStore: false }], 5)).toBeNull();
  });
});

describe('summarizeScores', () => {
  it('averages recall and MRR and counts hits', () => {
    const s = summarizeScores([
      { recall: 0.5, mrr: 0.5, hit: true },
      { recall: 0, mrr: 0, hit: false },
    ]);
    expect(s).toEqual({ n: 2, recall: 0.25, mrr: 0.25, hit: 1 });
  });
});

describe('percentile', () => {
  it('is the nearest-rank percentile', () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('parseQuerySet gold entries', () => {
  it('parses a gold list and keeps the legacy expected form', () => {
    const parsed = parseQuerySet(
      [
        { query: 'q', kind: 'ID', gold: [{ path: 'a.ts', anchor: 'foo' }] },
        { query: 'q2', expected: 'x.ts' },
      ],
      's',
    );
    expect(parsed).toEqual([
      { query: 'q', kind: 'ID', gold: [{ path: 'a.ts', anchor: 'foo' }] },
      { query: 'q2', expected: 'x.ts', kind: 'all' },
    ]);
  });

  it('rejects a gold with an empty path or anchor, or an empty list', () => {
    for (const gold of [[], [{ path: '', anchor: 'a' }], [{ path: 'a', anchor: '' }], 'x']) {
      expect(() => parseQuerySet([{ query: 'q', gold }], 's.json')).toThrow('s.json[0]');
    }
  });

  it('rejects an entry with neither gold nor expected', () => {
    expect(() => parseQuerySet([{ query: 'q' }], 's.json')).toThrow('s.json[0]');
  });
});

describe('checkDensePool', () => {
  it('leaves per-task embeddings out of both pools, as the production dense query does', async () => {
    const sent: string[] = [];
    const tx = { unsafe: async (q: string) => (sent.push(q), []) };
    const pg = { begin: async (_mode: string, fn: (t: typeof tx) => unknown) => fn(tx) };
    await checkDensePool(pg as never, '[0.1]', 2, 50, 'repo-1');
    const reads = sent.filter((q) => q.includes('ORDER BY'));
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q).toContain("source_type <> 'task'");
  });
});
