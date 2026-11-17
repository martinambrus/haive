/**
 * Local-only P3 experiment; no production search changes or hosted inference.
 * First materialize rag-eval-fixture.ts and build with rag-build-store.ts using
 * the manifest's scriptConfig (dry run first). This reader refuses missing stores.
 *
 * Required env: DATABASE_URL, RAG_PROJECT (fresh scratch store), RAG_REPOSITORY_ID,
 * RAG_QUERY_SET, RAG_RERANK_URL (llama.cpp /reranking origin), RAG_RERANK_PIN
 * (JSON with image/repo/revision/file/sha256/scoreScale), RAG_OUT (output prefix).
 * Optional RAG_OLLAMA_URL (default http://ollama:11434).
 * Writes <prefix>-hybrid.json, -rerank.json and -diagnostics.json. The two runs
 * work with rag-eval-compare.ts unchanged. All operator paths are held from /.
 * This fixture has no global/KB rows: the merge with an empty global arm is the
 * local page, re-reserved and sorted by RRF, as in mergeHits. Refuse other stores
 * rather than implying this measures the global merge's quota or expansion.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTextNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import {
  applyKnowledgeReserve,
  DEFAULT_RAG_SEARCH_CONFIG,
  embedQueryOrNull,
  isKnowledgeHit,
  openExistingRagDatabase,
  ragDatabaseName,
  ragHybridSearch,
  RAG_TABLE,
  type KnowledgeReserveOptions,
  type RagSearchHit,
} from '@haive/shared/rag';
import { fixtureFingerprint } from './rag-eval-fixture.js';
import { goldRank, goldsOf, parseQuerySet, percentile, scoreQuery } from './rag-eval-metrics.js';
import {
  bootstrapMean,
  METRIC_VERSION,
  noAnswerScore,
  overviewCoverage,
  SET_KS,
  type EvalRun,
  type QueryResult,
} from './rag-eval-report.js';

export type RerankedHit = RagSearchHit & { rerankScore: number };

/** Reject partial, duplicated, out-of-range or non-finite responses atomically.
 * Never interpret RRF/dense similarity as a reranker score. Equal model scores
 * keep the already merged shipped order, independent of response array order. */
export function sortRerankScores(hits: RagSearchHit[], response: unknown): RerankedHit[] {
  const rows = (response as { results?: unknown } | null)?.results;
  if (!Array.isArray(rows) || rows.length !== hits.length) throw new Error('incomplete scores');
  const scores = new Map<number, number>();
  for (const row of rows) {
    const { index, relevance_score: score } = row ?? {};
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= hits.length ||
      scores.has(index) ||
      typeof score !== 'number' ||
      !Number.isFinite(score)
    )
      throw new Error('invalid rerank score/index');
    scores.set(index, score);
  }
  return hits
    .map((h, index) => ({ ...h, rerankScore: scores.get(index)!, index }))
    .sort((a, b) => b.rerankScore - a.rerankScore || a.index - b.index)
    .map(({ index: _index, ...hit }) => hit);
}

/** Same quota, relative dense admission, small-page cap and append-only
 * promotion as applyKnowledgeReserve, with model order as the base order.
 * The shared helper hard-codes an RRF sort; copying its selection here avoids
 * overwriting RRF with a model score even temporarily. Parity has unit controls. */
export function reserveRerankedPage(
  hits: RerankedHit[],
  opts: KnowledgeReserveOptions,
): RerankedHit[] {
  const { topK, knowledgeReserve, knowledgeReserveRatio } = opts;
  if (topK <= 0) return [];
  const base = hits.slice(0, topK);
  const reserve = Math.min(knowledgeReserve, Math.floor(topK / 3));
  const slots = reserve - base.filter(isKnowledgeHit).length;
  const codeSims = base.filter((h) => !isKnowledgeHit(h)).map((h) => h.denseSim);
  if (slots <= 0 || !codeSims.length) return base;
  const key = (h: RagSearchHit) =>
    JSON.stringify([h.scope, h.sourcePath, h.sectionId, h.chunkIndex]);
  const held = new Set(base.map(key));
  const floor = Math.max(...codeSims) * knowledgeReserveRatio;
  const promoted = hits
    .filter((h) => isKnowledgeHit(h) && !held.has(key(h)) && h.denseSim >= floor)
    .sort((a, b) => b.denseSim - a.denseSim)
    .slice(0, slots);
  const drop = promoted.length;
  const kept = base.filter((h, index) => {
    // Drop the last code rows, retaining knowledge that earned its position.
    const codeAfter = base.slice(index + 1).filter((x) => !isKnowledgeHit(x)).length;
    if (!isKnowledgeHit(h) && codeAfter < drop) return false;
    return true;
  });
  return [...kept, ...promoted];
}

export async function rerankOrFallback(
  hits: RagSearchHit[],
  score: () => Promise<unknown>,
): Promise<{ hits: RagSearchHit[] | RerankedHit[]; fallback: boolean }> {
  if (!hits.length) return { hits: [], fallback: false };
  try {
    return { hits: sortRerankScores(hits, await score()), fallback: false };
  } catch {
    return { hits, fallback: true };
  }
}

/** Largest absolute adjacent drop among the first k model scores. Descriptive
 * only: no page is truncated and no threshold is selected on held-out data. */
export function scoreCliff(hits: RerankedHit[], k = 20) {
  const page = hits.slice(0, k);
  let drop = 0;
  let afterRank: number | null = null;
  for (let i = 1; i < page.length; i++) {
    const gap = page[i - 1]!.rerankScore - page[i]!.rerankScore;
    if (gap > drop) {
      drop = gap;
      afterRank = i;
    }
  }
  return {
    afterRank,
    drop,
    top: page[0]?.rerankScore ?? null,
    last: page.at(-1)?.rerankScore ?? null,
  };
}

export function localOrigin(raw: string): string {
  const u = new URL(raw);
  if (
    u.protocol !== 'http:' ||
    u.username ||
    u.password ||
    u.pathname !== '/' ||
    u.search ||
    u.hash ||
    (!['localhost', '127.0.0.1', '[::1]', 'ollama'].includes(u.hostname) &&
      !/^rrk-[a-z0-9-]+$/.test(u.hostname))
  )
    throw new Error('expected a local HTTP runtime origin');
  return u.origin;
}

function fromRoot(name: string): [string, string] {
  const full = path.resolve(name);
  const root = path.parse(full).root;
  return [root, full.slice(root.length)];
}
async function read(name: string) {
  const text = await readTextNoFollow(...fromRoot(name), { strict: true });
  if (text === null) throw new Error(`missing input: ${name}`);
  return text;
}
async function write(name: string, value: unknown) {
  await writeFileNoFollow(...fromRoot(name), JSON.stringify(value) + '\n', {
    mode: 'replace-atomic',
  });
}
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const { createDatabase } = await import('@haive/database');
  const { readBuildMeta, decideBuildMeta } = await import('./rag-build-store.js');
  const queryFile = required('RAG_QUERY_SET');
  const queryText = await read(queryFile);
  const manifestText = await read(path.join(path.dirname(queryFile), 'manifest.json'));
  const manifest = JSON.parse(manifestText);
  const queries = parseQuerySet(JSON.parse(queryText), queryFile);
  const pin = JSON.parse(await read(required('RAG_RERANK_PIN')));
  for (const key of ['image', 'repo', 'revision', 'file', 'sha256', 'scoreScale'])
    if (typeof pin[key] !== 'string' || !pin[key]) throw new Error(`missing reranker pin: ${key}`);
  const endpoint = localOrigin(required('RAG_RERANK_URL'));
  const ollamaUrl = localOrigin(process.env.RAG_OLLAMA_URL || 'http://ollama:11434');
  const repositoryId = required('RAG_REPOSITORY_ID');
  const out = required('RAG_OUT');
  const model = manifest.embedder.model as string;
  const dims = manifest.embedder.dimensions as number;
  if (model !== 'qwen3-embedding:4b') throw new Error('only the pinned local embedder is allowed');
  const tags = await fetch(`${ollamaUrl}/api/tags`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!tags.ok) throw new Error(`embedder tags HTTP ${tags.status}`);
  const tag = (
    (await tags.json()) as { models: { name: string; digest: string; remote_model?: string }[] }
  ).models.find((m) => m.name === model);
  if (!tag || tag.remote_model || tag.digest !== manifest.embedder.modelDigest)
    throw new Error('embedder digest mismatch');
  const db = createDatabase(required('DATABASE_URL'));
  const conn = await openExistingRagDatabase(db, ragDatabaseName(required('RAG_PROJECT')), dims);
  try {
    if (!conn) throw new Error('scratch store missing; build it with rag-build-store.ts first');
    const meta = await readBuildMeta(conn.pg);
    if (!meta || decideBuildMeta(meta, true, { model, dims }).action === 'refuse')
      throw new Error('scratch model mismatch');
    const rows = await conn.pg.unsafe(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE source_type <> 'code' OR repository_id IS DISTINCT FROM $1 OR chunk_hash IS NULL OR vector IS NULL)::int AS invalid FROM ${RAG_TABLE}`,
      [repositoryId],
    );
    if (!rows[0]?.n || rows[0].invalid)
      throw new Error('expected a real-vector, single-repository, code-only fixture store');
    const { topK: _topK, ...search } = DEFAULT_RAG_SEARCH_CONFIG;
    const settings = {
      embeddingModel: model,
      embeddingDimensions: dims,
      ks: [...SET_KS],
      repositoryScoped: true,
      search,
    };
    const hybrid: EvalRun = {
      metricVersion: METRIC_VERSION,
      fixture: fixtureFingerprint(manifestText, queryText),
      settings,
      results: [],
    };
    const rerank = {
      ...hybrid,
      settings: { ...settings, reranker: { ...pin, candidateK: 50 } },
      results: [] as QueryResult[],
    };
    const diagnostics: {
      id: string | undefined;
      kind: string;
      language: string | undefined;
      split: string | undefined;
      candidates: number;
      embedMs: number;
      poolMs: number;
      rerankMs: number;
      msPerChunk: number;
      fallback: boolean;
      response: unknown;
      cliff: ReturnType<typeof scoreCliff> | null;
    }[] = [];
    for (const q of queries) {
      const embedStart = performance.now();
      const vec = await embedQueryOrNull(q.query, {
        ollamaUrl,
        model,
        dimensions: dims,
        fetchFn: fetch,
      });
      const embedMs = performance.now() - embedStart;
      if (!vec) throw new Error(`query embedding failed: ${q.id}`);
      const golds = goldsOf(q);
      const inStore = await Promise.all(
        golds.map(async (g) => {
          const found = await conn.pg.unsafe(
            `SELECT source_path AS "sourcePath", content FROM ${RAG_TABLE} WHERE repository_id = $1 AND source_path = $2`,
            [repositoryId, g.path],
          );
          return goldRank(found as unknown as RagSearchHit[], g) !== null;
        }),
      );
      const base: QueryResult = {
        id: q.id!,
        query: q.query,
        kind: q.kind,
        language: q.language!,
        split: q.split!,
        labels: JSON.stringify({
          gold: q.gold,
          expected: q.expected,
          rubric: q.rubric,
          reason: q.reason,
        }),
        golds: golds.map((g, i) => ({ ...g, inStore: inStore[i]!, rank50: null })),
        byK: {},
      };
      const candidate: QueryResult = {
        ...base,
        golds: base.golds!.map((g) => ({ ...g })),
        byK: {},
      };
      let pool: RagSearchHit[] = [];
      let poolMs = 0;
      const recordPage = (result: QueryResult, hits: RagSearchHit[], k: number, ms: number) => {
        const ranks = golds.map((g) => goldRank(hits, g));
        if (k === 50)
          result.golds!.forEach((g, i) => {
            g.rank50 = ranks[i]!;
          });
        result.byK[k] = {
          score: scoreQuery(
            ranks.map((rank, i) => ({ rank, inStore: inStore[i]! })),
            k,
          ),
          ms,
          hits,
          topDenseSim: Math.max(0, ...hits.map((h) => h.denseSim)),
          topLexical: !!hits[0] && (hits[0].ranks?.fts != null || hits[0].ranks?.ident != null),
          overview: overviewCoverage(q, hits),
          noAnswer: q.kind === 'no-answer' ? noAnswerScore(hits) : null,
        };
      };
      for (const k of SET_KS) {
        const start = performance.now();
        const local = await ragHybridSearch(
          conn,
          vec,
          q.query,
          { ...search, topK: k },
          undefined,
          repositoryId,
        );
        // mergeHits(local, [], k), with no global rows or entry expansion.
        const merged = applyKnowledgeReserve(local, { ...search, topK: k });
        const ms = performance.now() - start;
        recordPage(base, merged, k, ms);
        if (k === 50) {
          pool = merged;
          poolMs = ms;
        }
      }
      let response: unknown;
      const start = performance.now();
      const scored = await rerankOrFallback(pool, async () => {
        const r = await fetch(`${endpoint}/reranking`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: q.query,
            documents: pool.map((h) => h.content),
            top_n: pool.length,
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (!r.ok) throw new Error(`reranker HTTP ${r.status}`);
        response = await r.json();
        return response;
      });
      const rerankMs = performance.now() - start;
      for (const k of SET_KS) {
        const hits = scored.fallback
          ? (base.byK[k]!.hits! as RagSearchHit[])
          : reserveRerankedPage(scored.hits as RerankedHit[], { ...search, topK: k });
        recordPage(candidate, hits, k, poolMs + rerankMs);
      }
      hybrid.results.push(base);
      rerank.results.push(candidate);
      diagnostics.push({
        id: q.id,
        kind: q.kind,
        language: q.language,
        split: q.split,
        candidates: pool.length,
        embedMs,
        poolMs,
        rerankMs,
        msPerChunk: rerankMs / (pool.length || 1),
        fallback: scored.fallback,
        response,
        cliff: scored.fallback ? null : scoreCliff(scored.hits as RerankedHit[]),
      });
      process.stdout.write(
        `${q.id}: ${pool.length} candidates; ${Math.round(rerankMs)} ms; fallback=${scored.fallback}\n`,
      );
    }
    await write(`${out}-hybrid.json`, hybrid);
    await write(`${out}-rerank.json`, rerank);
    await write(`${out}-diagnostics.json`, {
      pin,
      store: rows[0],
      queries: diagnostics,
      fallbackCount: diagnostics.filter((r) => r.fallback).length,
      latencyMs: Object.fromEntries(
        ['embedMs', 'poolMs', 'rerankMs', 'msPerChunk'].map((key) => [
          key,
          {
            p50: percentile(
              diagnostics.map((r) => r[key as 'embedMs']),
              50,
            ),
            p95: percentile(
              diagnostics.map((r) => r[key as 'embedMs']),
              95,
            ),
          },
        ]),
      ),
      cliffs: bootstrapMean(diagnostics.flatMap((d) => (d.cliff ? [d.cliff.drop] : []))),
    });
  } finally {
    await conn?.close();
    await db.$client.end({ timeout: 5 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  });
}
