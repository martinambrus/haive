import {
  goldRank,
  percentile,
  summarizeScores,
  type Gold,
  type QueryScore,
  type SetQuery,
} from './rag-eval-metrics.js';

export const METRIC_VERSION = 2;
export const SET_KS = [5, 8, 12, 20, 50];
export interface EvalHit {
  sourcePath: string;
  content: string;
  rrf: number;
  denseSim: number;
}
export interface EvalPage {
  score: QueryScore | null;
  ms: number;
  hits: EvalHit[];
  overview: number | null;
  noAnswer: { falsePositive: boolean; maxRrf: number; maxDense: number } | null;
}
export interface QueryResult {
  id: string;
  query: string;
  kind: string;
  language: string;
  split: string;
  labels: string;
  golds: (Gold & { inStore: boolean; rank50: number | null })[];
  byK: Record<string, EvalPage>;
  dense?: { indexRows: number; exactRows: number; overlap: number; defaultUsesHnsw: boolean };
}
export interface EvalRun {
  metricVersion: number;
  fixture: string;
  results: QueryResult[];
}

/** The author judges the facts/evidence in the fixture, not a model. Rechunking can
 * lose a fact, but never removes it from the coverage denominator. */
export function overviewCoverage(q: SetQuery, hits: EvalHit[]): number | null {
  if (!q.rubric) return null;
  return (
    q.rubric.filter((f) => f.evidence.some((g) => goldRank(hits, g) !== null)).length /
    q.rubric.length
  );
}

/** There is no abstention stage in the current search. Any returned hit on a
 * no-answer question is a false positive. RRF is recorded, not treated as a probability. */
export function noAnswerScore(hits: EvalHit[]): NonNullable<EvalPage['noAnswer']> {
  return {
    falsePositive: hits.length > 0,
    maxRrf: Math.max(0, ...hits.map((h) => h.rrf)),
    maxDense: Math.max(0, ...hits.map((h) => h.denseSim)),
  };
}

/** Query bootstrap, percentile 95% CI. Resample paired deltas, never the two arms
 * independently. Fixed xorshift32 seed; translation variants are not independent
 * topics, so this CI is descriptive query uncertainty, not a population claim. */
export function bootstrapMean(values: number[], samples = 2000, seed = 1729) {
  if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(seed))
    throw new Error('invalid bootstrap options');
  if (!values.every(Number.isFinite)) throw new Error('non-finite bootstrap value');
  if (!values.length) return { n: 0, mean: null, low: null, high: null };
  let state = seed | 0 || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const means = Array.from({ length: samples }, () => {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)]!;
    return sum / values.length;
  });
  return {
    n: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    low: percentile(means, 2.5),
    high: percentile(means, 97.5),
  };
}

export function summarizeGroup(results: QueryResult[], ks = SET_KS) {
  return Object.fromEntries(
    ks.map((k) => {
      const pages = results.map((r) => r.byK[k]).filter((p): p is EvalPage => !!p);
      if (pages.length !== results.length) throw new Error(`missing page k=${k}`);
      const scores = pages.flatMap((p) => (p.score ? [p.score] : []));
      const overviews = pages.flatMap((p) => (p.overview === null ? [] : [p.overview]));
      const negatives = pages.flatMap((p) => (p.noAnswer ? [p.noAnswer] : []));
      return [
        k,
        {
          answerable: {
            ...summarizeScores(scores),
            recallCI: bootstrapMean(scores.map((s) => s.recall)),
            mrrCI: bootstrapMean(scores.map((s) => s.mrr)),
          },
          overview: bootstrapMean(overviews),
          noAnswer: {
            ...bootstrapMean(negatives.map((s) => Number(s.falsePositive))),
            maxRrf: bootstrapMean(negatives.map((s) => s.maxRrf)),
            maxDense: bootstrapMean(negatives.map((s) => s.maxDense)),
          },
          searchMs: {
            p50: percentile(
              pages.map((p) => p.ms),
              50,
            ),
            p95: percentile(
              pages.map((p) => p.ms),
              95,
            ),
          },
        },
      ];
    }),
  );
}

export function resultGroups(results: QueryResult[]) {
  const groups: Record<string, QueryResult[]> = { all: results };
  for (const key of ['kind', 'language', 'split'] as const) {
    for (const value of new Set(results.map((r) => r[key])))
      groups[`${key}:${value}`] = results.filter((r) => r[key] === value);
  }
  for (const r of results) {
    const key = `cell:${r.kind}/${r.language}/${r.split}`;
    (groups[key] ??= []).push(r);
  }
  return groups;
}

export function summarizeRun(results: QueryResult[], ks = SET_KS) {
  const dense = results.flatMap((r) => (r.dense ? [r.dense] : []));
  return {
    groups: Object.fromEntries(
      Object.entries(resultGroups(results)).map(([name, rows]) => [name, summarizeGroup(rows, ks)]),
    ),
    missingGolds: results.reduce((n, r) => n + r.golds.filter((g) => !g.inStore).length, 0),
    dense: {
      overlap: bootstrapMean(dense.map((d) => d.overlap)),
      indexRows: bootstrapMean(dense.map((d) => d.indexRows)),
      exactRows: bootstrapMean(dense.map((d) => d.exactRows)),
      hnswPlan: dense.filter((d) => d.defaultUsesHnsw).length,
    },
  };
}

/** Refuse partial/intersected pairs: omissions must not flatter a candidate. */
export function compareRuns(
  before: EvalRun,
  after: EvalRun,
  ks = SET_KS,
  samples = 2000,
  seed = 1729,
) {
  if (before.metricVersion !== METRIC_VERSION || after.metricVersion !== METRIC_VERSION)
    throw new Error('metric version mismatch; rerun both arms');
  if (!before.fixture || before.fixture !== after.fixture)
    throw new Error('fixture/config mismatch');
  const indexed = (run: EvalRun) => {
    const out = new Map<string, QueryResult>();
    for (const row of run.results) {
      if (!row.id || out.has(row.id)) throw new Error('missing/duplicate query id');
      out.set(row.id, row);
    }
    return out;
  };
  const a = indexed(before);
  const b = indexed(after);
  if (!a.size || a.size !== b.size || [...a.keys()].some((id) => !b.has(id)))
    throw new Error('query sets differ');
  const deltas = [...a.values()].map((row) => {
    const next = b.get(row.id)!;
    for (const key of ['query', 'kind', 'language', 'split', 'labels'] as const) {
      if (row[key] !== next[key]) throw new Error(`query metadata/labels differ: ${row.id}`);
    }
    const byK = Object.fromEntries(
      ks.map((k) => {
        const p = row.byK[k];
        const q = next.byK[k];
        if (!p || !q) throw new Error(`missing paired page: ${row.id} k=${k}`);
        const delta = (x: number, y: number) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('non-finite score');
          return y - x;
        };
        if (row.kind === 'no-answer') {
          if (!p.noAnswer || !q.noAnswer) throw new Error('missing no-answer score');
          return [
            k,
            {
              falsePositive: delta(
                Number(p.noAnswer.falsePositive),
                Number(q.noAnswer.falsePositive),
              ),
              maxRrf: delta(p.noAnswer.maxRrf, q.noAnswer.maxRrf),
            },
          ];
        }
        if (row.kind === 'overview') {
          if (p.overview === null || q.overview === null) throw new Error('missing overview score');
          return [k, { coverage: delta(p.overview, q.overview) }];
        }
        if (!p.score || !q.score) throw new Error('missing answerable score');
        return [
          k,
          { recall: delta(p.score.recall, q.score.recall), mrr: delta(p.score.mrr, q.score.mrr) },
        ];
      }),
    );
    return { ...row, byK: row.byK, deltas: byK };
  });
  const groups = Object.fromEntries(
    Object.entries(resultGroups(deltas)).map(([name, rows]) => [
      name,
      Object.fromEntries(
        ks.map((k) => {
          const found = rows.map((r) => deltas.find((d) => d.id === r.id)!.deltas[k]!);
          const metrics = [...new Set(found.flatMap((d) => Object.keys(d)))];
          return [
            k,
            Object.fromEntries(
              metrics.map((metric) => {
                const values = found.flatMap((d) =>
                  typeof d[metric] === 'number' ? [d[metric]!] : [],
                );
                const direction = ['falsePositive', 'maxRrf'].includes(metric) ? -1 : 1;
                return [
                  metric,
                  {
                    ...bootstrapMean(values, samples, seed),
                    wins: values.filter((v) => v * direction > 0).length,
                    losses: values.filter((v) => v * direction < 0).length,
                    ties: values.filter((v) => v === 0).length,
                  },
                ];
              }),
            ),
          ];
        }),
      ),
    ]),
  );
  return {
    metricVersion: METRIC_VERSION,
    fixture: before.fixture,
    samples,
    seed,
    confidence: 'paired query bootstrap, percentile 95%; deltas = after - before',
    perQuery: deltas.map((d) => ({
      id: d.id,
      kind: d.kind,
      language: d.language,
      split: d.split,
      byK: d.deltas,
    })),
    groups,
  };
}
