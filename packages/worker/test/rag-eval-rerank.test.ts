import { describe, expect, it } from 'vitest';
import { applyKnowledgeReserve, type RagSearchHit } from '@haive/shared/rag';
import {
  localOrigin,
  rerankOrFallback,
  reserveRerankedPage,
  scoreCliff,
  sortRerankScores,
} from '../scripts/rag-eval-rerank.js';

const hit = (i: number, sourceType = 'code', denseSim = 0.8): RagSearchHit => ({
  sourcePath: `${i}.ts`,
  sectionId: 'function-test',
  chunkIndex: 0,
  sourceType,
  content: `chunk ${i}`,
  rrf: 1 / (61 + i),
  denseSim,
  hybrid: 0.56,
  tsNorm: 0,
});
const response = (...scores: number[]) => ({
  results: scores.map((relevance_score, index) => ({ index, relevance_score })),
});
const opts = { topK: 3, knowledgeReserve: 2, knowledgeReserveRatio: 0.75 };

it('uses the cross encoder score after merging, leaving every shipped score intact', () => {
  const hits = [hit(0), { ...hit(1), scope: 'global' as const }];
  const saved = structuredClone(hits);
  const out = sortRerankScores(hits, response(-2, 3));
  expect(out.map((h) => h.sourcePath)).toEqual(['1.ts', '0.ts']);
  expect(out[0]).toEqual({ ...hits[1], rerankScore: 3 });
  expect(out[1]).toEqual({ ...hits[0], rerankScore: -2 });
  expect(hits).toEqual(saved);
});
it('ties keep merged shipped order, even when response order is reversed', () => {
  const raw = response(0.5, 0.5, 0.1);
  raw.results.reverse();
  expect(sortRerankScores([hit(0), hit(1), hit(2)], raw).map((h) => h.sourcePath)).toEqual([
    '0.ts',
    '1.ts',
    '2.ts',
  ]);
});
it.each([
  null,
  {},
  response(1),
  {
    results: [
      { index: 0, relevance_score: 1 },
      { index: 0, relevance_score: 2 },
    ],
  },
  {
    results: [
      { index: 0, relevance_score: 1 },
      { index: 2, relevance_score: 2 },
    ],
  },
  {
    results: [
      { index: -1, relevance_score: 1 },
      { index: 1, relevance_score: 2 },
    ],
  },
  {
    results: [
      { index: 0.5, relevance_score: 1 },
      { index: 1, relevance_score: 2 },
    ],
  },
  response(1, NaN),
  response(1, Infinity),
  {
    results: [
      { index: 0, relevance_score: '1' },
      { index: 1, relevance_score: 2 },
    ],
  },
  {
    results: [
      { index: 0, score: 1 },
      { index: 1, rrf: 2 },
    ],
  },
])('malformed responses fall back atomically to the original shipped order: %j', async (raw) => {
  const hits = [hit(0), hit(1)];
  const out = await rerankOrFallback(hits, async () => raw);
  expect(out.fallback).toBe(true);
  expect(out.hits).toBe(hits);
  expect(out.hits.some((h) => 'rerankScore' in h)).toBe(false);
});
it('transport failures keep shipped order, and empty pools need no call', async () => {
  const hits = [hit(0)];
  expect(
    await rerankOrFallback(hits, async () => {
      throw new Error('offline');
    }),
  ).toEqual({ hits, fallback: true });
  expect(
    await rerankOrFallback([], async () => {
      throw new Error('must not call');
    }),
  ).toEqual({ hits: [], fallback: false });
});
describe('knowledge reserve after model ordering', () => {
  it('promotes only cut knowledge, with the small-page cap, without score changes', () => {
    const hits = sortRerankScores(
      [hit(0), hit(1), hit(2), hit(3, 'kb')],
      response(0.9, 0.8, 0.7, 0.1),
    );
    expect(reserveRerankedPage(hits, opts)).toEqual([hits[0], hits[1], hits[3]]);
    expect(reserveRerankedPage(hits, { ...opts, topK: 2 })).toEqual(hits.slice(0, 2));
    expect(reserveRerankedPage(hits, { ...opts, knowledgeReserve: 0 })).toEqual(hits.slice(0, 3));
  });
  it('keeps earned knowledge at its model rank and does not reserve task rows', () => {
    const hits = sortRerankScores(
      [hit(0), hit(1, 'kb'), hit(2), hit(3, 'task')],
      response(4, 3, 2, 1),
    );
    expect(reserveRerankedPage(hits, opts)).toEqual(hits.slice(0, 3));
    const task = sortRerankScores([hit(0), hit(1), hit(2), hit(3, 'task')], response(4, 3, 2, 1));
    expect(reserveRerankedPage(task, opts)).toEqual(task.slice(0, 3));
  });
  it('has the shared helper quota semantics when model and RRF orders agree', () => {
    const cases = [
      [hit(0), hit(1), hit(2), hit(3, 'kb'), hit(4, 'learning')],
      [hit(0), hit(1), hit(2), hit(3, 'kb', 0.2)],
      [hit(0, 'kb'), hit(1, 'runbook'), hit(2, 'learning'), hit(3, 'kb')],
      [hit(0), hit(1, 'kb'), hit(2), hit(3), hit(4), hit(5), hit(6, 'runbook')],
      [hit(0), hit(1), hit(2), hit(3), hit(4), hit(5), hit(6, 'kb'), hit(7, 'learning')],
    ];
    for (const input of cases)
      for (const topK of [0, 1, 3, 6, 12]) {
        const scored = sortRerankScores(input, response(...input.map((_, i) => -i)));
        const expected = applyKnowledgeReserve(input, { ...opts, topK });
        expect(reserveRerankedPage(scored, { ...opts, topK }).map((h) => h.sourcePath)).toEqual(
          expected.map((h) => h.sourcePath),
        );
      }
  });
});
it('reports an absolute score cliff descriptively, preferring the first tied drop', () => {
  const scored = sortRerankScores([hit(0), hit(1), hit(2)], response(0.9, 0.5, 0.1));
  expect(scoreCliff(scored)).toMatchObject({ afterRank: 1, drop: 0.4, top: 0.9, last: 0.1 });
  expect(scoreCliff([])).toEqual({ afterRank: null, drop: 0, top: null, last: null });
});
it('refuses hosted runtime URLs and redirects through URL components', () => {
  expect(localOrigin('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
  expect(localOrigin('http://rrk-test:8080')).toBe('http://rrk-test:8080');
  for (const url of [
    'https://example.com',
    'http://example.com',
    'http://localhost/x',
    'http://localhost?url=x',
    'http://localhost#x',
  ])
    expect(() => localOrigin(url)).toThrow();
});
