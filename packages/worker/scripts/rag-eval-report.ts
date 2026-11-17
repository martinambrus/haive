import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readTextNoFollow } from '@haive/shared/fs-safe';
import type { RagSearchConfig } from '@haive/shared/rag';
import { FIXTURE_DIR, sha256, warnChunkerDrift, type FixtureManifest } from './rag-eval-fixture.js';
import {
  goldRank,
  percentile,
  summarizeScores,
  type Gold,
  type QueryScore,
  type SetQuery,
} from './rag-eval-metrics.js';

export const METRIC_VERSION = 3;
export const SET_KS = [5, 8, 12, 20, 50];
export interface EvalHit {
  sourcePath: string;
  content: string;
  rrf: number;
  denseSim: number;
}
export interface EvalPage {
  score: QueryScore | null;
  ms?: number;
  hits?: EvalHit[];
  /** Maximum dense similarity on this returned page; zero for an empty/lexical page. */
  topDenseSim?: number;
  /** The first returned hit has an FTS or identifier candidate rank. */
  topLexical?: boolean;
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
  signal?: { k: number; topDenseSim: number; topLexical: boolean };
  golds?: (Gold & { inStore: boolean; rank50: number | null })[];
  byK: Record<string, EvalPage>;
  dense?: { indexRows: number; exactRows: number; overlap: number; defaultUsesHnsw: boolean };
}
export interface EvalSettings {
  embeddingModel: string;
  embeddingDimensions: number;
  ks: number[];
  repositoryScoped: boolean;
  /** Experiment variables: arm and ranking knobs may differ between paired runs. */
  search: Omit<RagSearchConfig, 'topK'>;
}
export interface EvalRun {
  metricVersion: number;
  fixture: string;
  /** Optional for reading legacy outputs; comparisons require observed settings. */
  settings?: EvalSettings;
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

/** Secondary any-hit diagnostic: search has no abstention stage. The primary
 * offline FPR uses the tuning tau in answerabilityReport. RRF is not a probability. */
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
              pages.flatMap((p) => (p.ms === undefined ? [] : [p.ms])),
              50,
            ),
            p95: percentile(
              pages.flatMap((p) => (p.ms === undefined ? [] : [p.ms])),
              95,
            ),
          },
        },
      ];
    }),
  );
}

export function resultGroups<T extends QueryResult>(results: T[]) {
  const groups: Record<string, T[]> = { all: results };
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
    answerability: Object.fromEntries(ks.map((k) => [k, availableAnswerability(results, k)])),
    missingGolds: results.reduce((n, r) => n + (r.golds ?? []).filter((g) => !g.inStore).length, 0),
    dense: {
      overlap: bootstrapMean(dense.map((d) => d.overlap)),
      indexRows: bootstrapMean(dense.map((d) => d.indexRows)),
      exactRows: bootstrapMean(dense.map((d) => d.exactRows)),
      hnswPlan: dense.filter((d) => d.defaultUsesHnsw).length,
    },
  };
}

const denseSignal = (r: QueryResult, k: number) =>
  r.byK[k]?.topDenseSim ?? (r.signal?.k === k ? r.signal.topDenseSim : undefined);
const availableAnswerability = (results: QueryResult[], k: number) =>
  results.every((r) => denseSignal(r, k) !== undefined) ? answerabilityReport(results, k) : null;
const labelIdentity = (s: string) => (/^[a-f0-9]{64}$/.test(s) ? s : sha256(s));

/** Mann–Whitney AUROC, with half credit for ties. Positives include overview. */
export function answerabilityReport(results: QueryResult[], k: number) {
  const rows = results.map((r) => {
    const score = denseSignal(r, k);
    if (score === undefined || !Number.isFinite(score))
      throw new Error(`missing/non-finite dense signal: ${r.id} k=${k}`);
    return { ...r, score, positive: r.kind !== 'no-answer' };
  });
  const tuning = rows
    .filter((r) => r.split === 'tuning' && r.positive)
    .map((r) => r.score)
    .sort((a, b) => b - a);
  // Highest observed cutoff retaining at least ceil(90% * n) tuning positives.
  const tau = tuning[Math.ceil(0.9 * tuning.length) - 1] ?? null;
  const grade = (subset: typeof rows) => {
    const positives = subset.filter((r) => r.positive);
    const negatives = subset.filter((r) => !r.positive);
    const auc = positives.reduce(
      (sum, p) =>
        sum +
        negatives.reduce((n, q) => n + (p.score > q.score ? 1 : p.score === q.score ? 0.5 : 0), 0),
      0,
    );
    const falsePositives = tau === null ? null : negatives.filter((p) => p.score >= tau).length;
    const fpr =
      falsePositives === null || !negatives.length ? null : falsePositives / negatives.length;
    // Wilson score interval, z = Phi^-1(0.975). Unlike a bootstrap with constant
    // outcomes it retains uncertainty at 0/n and n/n; translated queries still correlate.
    const z2 = 1.959963984540054 ** 2;
    const n = negatives.length;
    const center = fpr === null ? 0 : (fpr + z2 / (2 * n)) / (1 + z2 / n);
    const half =
      fpr === null
        ? 0
        : (Math.sqrt((fpr * (1 - fpr)) / n + z2 / (4 * n * n)) * Math.sqrt(z2)) / (1 + z2 / n);
    return {
      answerable: positives.length,
      noAnswer: negatives.length,
      auroc:
        positives.length && negatives.length ? auc / (positives.length * negatives.length) : null,
      retention:
        tau === null || !positives.length
          ? null
          : positives.filter((p) => p.score >= tau).length / positives.length,
      falsePositives,
      fpr,
      fprCI: fpr === null ? null : bootstrapMean(negatives.map((p) => Number(p.score >= tau!))),
      fprWilson95:
        fpr === null ? null : { low: Math.max(0, center - half), high: Math.min(1, center + half) },
    };
  };
  return {
    tau,
    targetRetention: 0.9,
    all: grade(rows),
    tuning: grade(rows.filter((r) => r.split === 'tuning')),
    heldOut: grade(rows.filter((r) => r.split === 'held-out')),
    // Calibrate once on the entire run, never again inside a cell or marginal.
    groups: Object.fromEntries(
      Object.entries(resultGroups(rows)).map(([name, subset]) => [name, grade(subset)]),
    ),
  };
}

/** Committed baselines keep query records, scores and signals, without runtime dumps. */
export function compactRun(run: EvalRun): EvalRun {
  return {
    metricVersion: run.metricVersion,
    fixture: run.fixture,
    settings: run.settings,
    results: run.results.map(({ dense: _dense, golds, ...r }) => ({
      ...r,
      labels: labelIdentity(r.labels),
      ...(golds?.some((g) => !g.inStore) ? { golds: golds.filter((g) => !g.inStore) } : {}),
      signal: r.signal ?? {
        k: 8,
        topDenseSim: r.byK[8]!.topDenseSim!,
        topLexical: r.byK[8]!.topLexical!,
      },
      byK: Object.fromEntries(
        Object.entries(r.byK).map(([k, p]) => [
          k,
          {
            score: p.score,
            overview: p.overview,
            noAnswer: p.noAnswer,
          },
        ]),
      ),
    })),
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
  if (!before.fixture || !after.fixture)
    throw new Error(
      'not comparable: no fixture manifest; run with RAG_MANIFEST to compare fixture results',
    );
  if (before.fixture !== after.fixture) throw new Error('fixture/config mismatch');
  for (const run of [before, after]) {
    const s = run.settings;
    if (!s || typeof s !== 'object')
      throw new Error('missing observed settings; rerun or restore provenance');
    if (typeof s.embeddingModel !== 'string' || !s.embeddingModel.trim())
      throw new Error('invalid settings.embeddingModel');
    if (!Number.isInteger(s.embeddingDimensions) || s.embeddingDimensions <= 0)
      throw new Error('invalid settings.embeddingDimensions');
    if (!Array.isArray(s.ks) || !s.ks.length || s.ks.some((k) => !Number.isInteger(k) || k < 1))
      throw new Error('invalid settings.ks');
    if (typeof s.repositoryScoped !== 'boolean')
      throw new Error('invalid settings.repositoryScoped');
    if (!s.search || typeof s.search !== 'object') throw new Error('missing settings.search');
  }
  // Corpus/labels are fingerprinted separately. Freeze the embedder, page protocol
  // and repository-scoped search policy; retain both arms' ranking knobs below.
  for (const field of [
    'embeddingModel',
    'embeddingDimensions',
    'ks',
    'repositoryScoped',
  ] as const) {
    if (JSON.stringify(before.settings![field]) !== JSON.stringify(after.settings![field]))
      throw new Error(`fixed settings.${field} mismatch`);
  }
  for (const k of ks)
    if (!before.settings!.ks.includes(k)) throw new Error(`settings.ks does not include k=${k}`);
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
  // Each arm calibrates its global tau on its own tuning positives only.
  // Compact baselines have signals at k=8 only; other k values stay unavailable.
  const answerability = Object.fromEntries(
    ks.map((k) => [
      k,
      {
        before: availableAnswerability(before.results, k),
        after: availableAnswerability(after.results, k),
      },
    ]),
  );
  const deltas = [...a.values()].map((row) => {
    const next = b.get(row.id)!;
    for (const key of ['query', 'kind', 'language', 'split', 'labels'] as const) {
      if (
        (key === 'labels' ? labelIdentity(row[key]) : row[key]) !==
        (key === 'labels' ? labelIdentity(next[key]) : next[key])
      )
        throw new Error(`query metadata/labels differ: ${row.id}`);
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
          const beforeTau = answerability[k]!.before?.tau;
          const afterTau = answerability[k]!.after?.tau;
          return [
            k,
            {
              fpr:
                beforeTau == null || afterTau == null
                  ? null
                  : delta(
                      Number(denseSignal(row, k)! >= beforeTau),
                      Number(denseSignal(next, k)! >= afterTau),
                    ),
              anyHit: delta(Number(p.noAnswer.falsePositive), Number(q.noAnswer.falsePositive)),
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
          const metrics = [
            ...new Set(
              found.flatMap((d) => Object.keys(d).filter((key) => typeof d[key] === 'number')),
            ),
          ];
          return [
            k,
            Object.fromEntries(
              metrics.map((metric) => {
                const values = found.flatMap((d) =>
                  typeof d[metric] === 'number' ? [d[metric]!] : [],
                );
                const direction = ['fpr', 'anyHit', 'maxRrf'].includes(metric) ? -1 : 1;
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
    settings: { before: before.settings, after: after.settings },
    samples,
    seed,
    confidence: 'paired query bootstrap, percentile 95%; deltas = after - before',
    answerability,
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

/** Exact Markdown cell table for the plan; all metrics come from summarizeRun. */
export function renderCellTable(hybrid: EvalRun, lexical: EvalRun): string {
  // Enforce the same pairing contract as comparisons before presenting side by side.
  compareRuns(lexical, hybrid, [8]);
  const h = summarizeRun(hybrid.results, [8]);
  const l = summarizeRun(lexical.results, [8]);
  const num = (n: number) => n.toFixed(3);
  const ci = (s: ReturnType<typeof bootstrapMean>) =>
    s.mean === null ? 'unavailable' : `${num(s.mean)} [${num(s.low!)}, ${num(s.high!)}]`;
  const rows = [
    '| class | language | split | n | hybrid metric [95% CI] | lexical metric [95% CI] |',
    '|---|---|---|---:|---|---|',
  ];
  for (const [name, group] of Object.entries(h.groups)) {
    if (!name.startsWith('cell:')) continue;
    const [kind, language, split] = name.slice(5).split('/');
    const a = group[8]!;
    const b = l.groups[name]![8]!;
    let n: number;
    let left: string;
    let right: string;
    if (kind === 'no-answer') {
      const x = h.answerability[8]?.groups[name];
      const y = l.answerability[8]?.groups[name];
      n = x?.noAnswer ?? a.noAnswer.n;
      left = x?.fprCI ? ci(x.fprCI) : 'unavailable';
      right = y?.fprCI ? ci(y.fprCI) : 'unavailable';
    } else if (kind === 'overview') {
      n = a.overview.n;
      left = ci(a.overview);
      right = ci(b.overview);
    } else {
      n = a.answerable.n;
      left = `${ci(a.answerable.recallCI)} / ${num(a.answerable.mrr)}`;
      right = `${ci(b.answerable.recallCI)} / ${num(b.answerable.mrr)}`;
    }
    rows.push(`| ${kind} | ${language} | ${split} | ${n} | ${left} | ${right} |`);
  }
  return rows.join('\n') + '\n';
}

/** Offline summary, recomputed from compact query records. */
async function main() {
  const cells = process.argv[2] === '--cells';
  const filenames = cells ? process.argv.slice(3) : process.argv.slice(2);
  if (filenames.length !== (cells ? 2 : 1))
    throw new Error('usage: rag-eval-report.ts run.json | --cells hybrid.json lexical.json');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const manifest = JSON.parse(
    (await readTextNoFollow(root, `${FIXTURE_DIR}/manifest.json`))!,
  ) as FixtureManifest;
  await warnChunkerDrift(root, manifest);
  const runs = await Promise.all(
    filenames.map(async (filename) => {
      // Held from the filesystem root: a linked parent cannot redirect an operator path.
      const full = path.resolve(filename);
      const fsRoot = path.parse(full).root;
      return JSON.parse((await readTextNoFollow(fsRoot, full.slice(fsRoot.length)))!) as EvalRun;
    }),
  );
  process.stdout.write(
    cells
      ? renderCellTable(runs[0]!, runs[1]!)
      : JSON.stringify(summarizeRun(runs[0]!.results), null, 2) + '\n',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
