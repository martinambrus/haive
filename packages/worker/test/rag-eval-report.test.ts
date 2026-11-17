import { describe, expect, it } from 'vitest';
import { parseQuerySet, scoreQuery } from '../scripts/rag-eval-metrics.js';
import {
  answerabilityReport,
  compactRun,
  bootstrapMean,
  compareRuns,
  METRIC_VERSION,
  noAnswerScore,
  overviewCoverage,
  summarizeRun,
  type EvalPage,
  type EvalRun,
  type QueryResult,
} from '../scripts/rag-eval-report.js';

const hit = (anchor: string) => ({
  sourcePath: 'a.ts',
  content: `[a.ts]\n${anchor}`,
  rrf: 0.02,
  denseSim: 0.6,
});
const page = (recall: number): EvalPage => ({
  score: { recall, mrr: recall, hit: recall > 0 },
  ms: 2,
  hits: [],
  overview: null,
  noAnswer: null,
});
function row(id: string, recall: number, kind = 'identifier'): QueryResult {
  return {
    id,
    query: id,
    kind,
    language: 'en',
    split: 'held-out',
    labels: 'fixed',
    golds: [],
    byK: { 8: page(recall) },
  };
}
const run = (results: QueryResult[]): EvalRun => ({
  metricVersion: METRIC_VERSION,
  fixture: 'same-corpus-config',
  results,
});

describe('query classes', () => {
  it('keeps negative metadata and refuses positive labels on a no-answer question', () => {
    const q = {
      id: 'n',
      query: 'missing subsystem',
      kind: 'no-answer',
      language: 'sk',
      split: 'tuning',
      reason: 'absent from corpus',
    };
    expect(parseQuerySet([q], 's')[0]).toEqual(q);
    for (const extra of [{ gold: [] }, { expected: 'a' }, { reason: '' }, { split: 'random' }])
      expect(() => parseQuerySet([{ ...q, ...extra }], 's')).toThrow();
  });
  it('requires multi-fact overview judgments, preserving all original facts', () => {
    const rubric = [
      { fact: 'x', evidence: [{ path: 'a.ts', anchor: 'x' }] },
      { fact: 'y', evidence: [{ path: 'a.ts', anchor: 'y' }] },
    ];
    const [q] = parseQuerySet([{ query: 'overview', kind: 'overview', rubric }], 's');
    expect(overviewCoverage(q!, [hit('x')])).toBe(0.5);
    expect(overviewCoverage(q!, [hit('x y')])).toBe(1);
    expect(overviewCoverage(q!, [])).toBe(0);
    expect(() =>
      parseQuerySet([{ query: 'overview', kind: 'overview', rubric: rubric.slice(0, 1) }], 's'),
    ).toThrow();
    expect(() =>
      parseQuerySet(
        [{ query: 'overview', kind: 'overview', rubric, gold: [{ path: 'a.ts', anchor: 'x' }] }],
        's',
      ),
    ).toThrow();
  });
  it('rejects duplicate ids and invalid metadata', () => {
    const q = { id: 'a', query: 'a', expected: 'a' };
    expect(() => parseQuerySet([q, q], 's')).toThrow('duplicate id');
    for (const extra of [{ language: '' }, { topic: 3 }, { rubric: [] }])
      expect(() => parseQuerySet([{ ...q, ...extra }], 's')).toThrow();
  });
  it('defines no-answer FPR by any returned hit, separately from score magnitude', () => {
    expect(noAnswerScore([])).toEqual({ falsePositive: false, maxRrf: 0, maxDense: 0 });
    expect(noAnswerScore([{ ...hit('irrelevant'), rrf: 0, denseSim: 0 }])).toEqual({
      falsePositive: true,
      maxRrf: 0,
      maxDense: 0,
    });
    expect(noAnswerScore([hit('irrelevant')]).maxDense).toBe(0.6);
  });
  it('does not let an inconsistent absent gold gain recall; an empty list has no recall target', () => {
    expect(scoreQuery([{ rank: 1, inStore: false }], 8)?.recall).toBe(0);
    expect(scoreQuery([], 8)).toBeNull();
  });
});

describe('seeded bootstrap', () => {
  it('handles empty, single and constant samples exactly', () => {
    expect(bootstrapMean([])).toEqual({ n: 0, mean: null, low: null, high: null });
    expect(bootstrapMean([0.5], 20)).toEqual({ n: 1, mean: 0.5, low: 0.5, high: 0.5 });
    expect(bootstrapMean([0, 0], 20).high).toBe(0);
  });
  it('is reproducible and encloses the known mean for symmetric query deltas', () => {
    const first = bootstrapMean([-1, 0, 1], 100, 1729);
    expect(first).toEqual(bootstrapMean([-1, 0, 1], 100, 1729));
    expect(first.mean).toBe(0);
    expect(first.low).toBeLessThan(0);
    expect(first.high).toBeGreaterThan(0);
    expect(() => bootstrapMean([NaN])).toThrow();
    expect(() => bootstrapMean([1], 0)).toThrow();
  });
});

describe('summaries', () => {
  it('separates class, language, split and cells and keeps misses in the answerable count', () => {
    const negative = row('n', 0, 'no-answer');
    negative.byK[8] = { ...page(0), score: null, noAnswer: noAnswerScore([hit('junk')]) };
    const overview = row('o', 0, 'overview');
    overview.language = 'fr';
    overview.split = 'tuning';
    overview.byK[8] = { ...page(0), score: null, overview: 0.5 };
    const s = summarizeRun([row('a', 1), row('missing', 0), negative, overview], [8]);
    expect(s.groups.all![8]!.answerable).toMatchObject({ n: 2, recall: 0.5 });
    expect(s.groups.all![8]!.noAnswer).toMatchObject({ n: 1, mean: 1 });
    expect(s.groups.all![8]!.overview).toMatchObject({ n: 1, mean: 0.5 });
    expect(s.groups['cell:overview/fr/tuning']![8]!.overview.mean).toBe(0.5);
    expect(s.groups['language:en']![8]!.answerable.n).toBe(2);
    expect(s.groups['split:held-out']![8]!.answerable.n).toBe(2);
    expect(() => summarizeRun([row('a', 1)], [5])).toThrow('missing page');
  });
});

describe('paired comparisons', () => {
  it('aligns by id, reports per-query deltas, wins/losses/ties and a paired CI', () => {
    const before = run([row('a', 0), row('b', 1), row('c', 0.5)]);
    const after = run([row('c', 0.5), row('b', 0), row('a', 1)]);
    const comparison = compareRuns(before, after, [8], 100);
    expect(comparison.perQuery[0]!.byK[8]).toEqual({ recall: 1, mrr: 1 });
    expect(comparison.groups.all![8]!.recall).toMatchObject({
      n: 3,
      mean: 0,
      wins: 1,
      losses: 1,
      ties: 1,
    });
    const self = compareRuns(before, before, [8], 100);
    expect(self.groups.all![8]!.recall).toMatchObject({
      mean: 0,
      low: 0,
      high: 0,
      wins: 0,
      losses: 0,
      ties: 3,
    });
  });
  it('treats fewer no-answer false positives as a win and overview coverage separately', () => {
    const a = row('n', 0, 'no-answer');
    const b = row('n', 0, 'no-answer');
    a.byK[8] = { ...page(0), score: null, noAnswer: noAnswerScore([hit('junk')]) };
    b.byK[8] = { ...page(0), score: null, noAnswer: noAnswerScore([]) };
    expect(compareRuns(run([a]), run([b]), [8], 10).groups.all![8]!.falsePositive).toMatchObject({
      mean: -1,
      wins: 1,
      losses: 0,
    });
    a.kind = b.kind = 'overview';
    a.byK[8]!.overview = 0.5;
    b.byK[8]!.overview = 1;
    expect(compareRuns(run([a]), run([b]), [8], 10).groups.all![8]!.coverage!.mean).toBe(0.5);
  });
  it('refuses missing queries, duplicates, changed labels, old metrics, different corpus and missing scores', () => {
    const good = run([row('a', 1)]);
    const bad = [
      run([]),
      run([row('a', 1), row('a', 1)]),
      { ...good, metricVersion: 1 },
      { ...good, fixture: 'different' },
      run([{ ...row('a', 1), labels: 'changed' }]),
      run([{ ...row('a', 1), byK: {} }]),
      run([{ ...row('a', 1), query: 'changed' }]),
    ];
    for (const candidate of bad) expect(() => compareRuns(good, candidate, [8], 10)).toThrow();
  });
});

describe('dense answerability', () => {
  const scored = (id: string, score: number, split: string, kind = 'identifier'): QueryResult => ({
    ...row(id, 1, kind),
    split,
    byK: { 8: { ...page(1), topDenseSim: score, topLexical: false } },
  });
  it('fixes tau on tuning positives and grades held-out without threshold leakage', () => {
    const rows = Array.from({ length: 10 }, (_, i) => scored(`t${i}`, i / 10, 'tuning'));
    rows.push(scored('p', 0.15, 'held-out'), scored('n', 0.2, 'held-out', 'no-answer'));
    const r = answerabilityReport(rows, 8);
    expect(r.tau).toBe(0.1);
    expect(r.tuning.retention).toBe(0.9);
    expect(r.heldOut.retention).toBe(1);
    expect(r.heldOut.fpr).toBe(1);
    expect(r.heldOut.auroc).toBe(0);
    rows[11]!.byK[8]!.topDenseSim = 0.15;
    expect(answerabilityReport(rows, 8).heldOut.auroc).toBe(0.5);
    rows[11]!.byK[8]!.topDenseSim = 0.05;
    expect(answerabilityReport(rows, 8).heldOut).toMatchObject({ auroc: 1, fpr: 0 });
    expect(answerabilityReport([], 8).tau).toBeNull();
    expect(() => answerabilityReport([row('missing', 1)], 8)).toThrow('dense signal');
    rows[0]!.byK[8]!.topDenseSim = NaN;
    expect(() => answerabilityReport(rows, 8)).toThrow('dense signal');
  });
  it('keeps ties at tau and includes overview as answerable', () => {
    const rows = [
      scored('t', 0, 'tuning', 'overview'),
      scored('p', 0, 'held-out'),
      scored('n', 0, 'held-out', 'no-answer'),
    ];
    expect(answerabilityReport(rows, 8)).toMatchObject({ tau: 0, heldOut: { auroc: 0.5, fpr: 1 } });
  });
  it('compacts without losing scores or signals and recomputes summaries', () => {
    const r = scored('t', 0.6, 'tuning');
    r.dense = { indexRows: 50, exactRows: 50, overlap: 1, defaultUsesHnsw: false };
    const compact = compactRun(run([r]));
    expect(compact.results[0]!.dense).toBeUndefined();
    expect(compact.results[0]!.signal).toEqual({ k: 8, topDenseSim: 0.6, topLexical: false });
    expect(compact.results[0]!.byK[8]).toEqual({
      score: page(1).score,
      overview: null,
      noAnswer: null,
    });
    expect(summarizeRun(compact.results, [8]).groups.all![8]!.answerable.recall).toBe(1);
  });
});
