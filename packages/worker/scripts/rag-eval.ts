/**
 * RAG retrieval eval / tuning harness.
 *
 * Runs hybrid queries against a project's RAG database and prints the
 * dense / lexical / hybrid / RRF scores and ranks, so the scoring knobs
 * (DEFAULT_RAG_SEARCH_CONFIG in @haive/shared/rag) can be calibrated against
 * real data. Also serves as the manual regression check for the reported bug:
 * a genuinely-relevant code hit must clear the gate and rank in the top-k even
 * when its lexical score is ~0. Read-only: an internal-mode database that does
 * not exist is refused, never created.
 *
 * Run inside the worker container (has DATABASE_URL + ollama reachable):
 *   docker exec -e RAG_QUERY="task list exposed filters views" \
 *     -e RAG_PROJECT="myproject" -e RAG_EXPECTED="views_query_alter" \
 *     haive-worker pnpm --filter @haive/worker exec tsx scripts/rag-eval.ts
 *   docker exec -e RAG_QUERY_SET=/tmp/set.json -e RAG_LEXICAL_ONLY=1 ... (query set)
 *
 * Env:
 *   RAG_QUERY     the search query (required unless RAG_QUERY_SET is set)
 *   RAG_QUERY_SET path to JSON [{ "query", "kind"?, "gold": [{ "path", "anchor" }] }]. A hit holds a
 *                 gold when its source_path equals "path" and its body (the chunk after its first
 *                 line, the "[path > ...]" header) contains "anchor"; the legacy entry
 *                 { "query", "expected" (source_path substring) } still works. A gold with no such
 *                 row in the store is reported "not in store" and left out of that query's scores.
 *                 One search per page size in {5, 8, 12, 20, 50} reusing one embedding; prints
 *                 recall@k, MRR@k and hit@k per kind and overall, and the p50/p95 search time
 *   RAG_LEXICAL_ONLY  1 skips the embed so the lexical-only branch runs
 *   RAG_IDENTIFIER_SEARCH  0 turns the identifier ranker off (default on)
 *   RAG_PROJECT   project name (internal mode db = haive_rag_<project>); default "default"
 *   RAG_MODE      internal | external | ddev   (default internal)
 *   RAG_CONN      connection string for external/ddev
 *   RAG_OLLAMA_URL  default http://ollama:11434
 *   RAG_MODEL     default qwen3-embedding:4b
 *   RAG_DIMS      default 2560
 *   RAG_TOPK      default 10; page size of a single RAG_QUERY (a query set uses its own sizes)
 *   RAG_REPOSITORY_ID  optional repository_id passed to the search and the in-store check
 *   RAG_DENSE_CHECK  1 also compares the dense pool at LIMIT 50 through the HNSW index (forced)
 *                 with an exact scan per query: rows returned, overlap@50 and the default plan
 *   RAG_OUT       path to write the per-query results and the summary as JSON
 *   RAG_EXPECTED  optional substring of an expected source_path to report its rank
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createDatabase } from '@haive/database';
import {
  embedQueryOrNull,
  openExistingRagDatabase,
  ragDatabaseName,
  ragHybridSearch,
  RAG_TABLE,
  resolveRagConnection,
  type RagConnection,
  type RagMode,
  type RagSearchHit,
  type RagToolingPrefs,
  vectorLiteral,
} from '@haive/shared/rag';
import { decideBuildMeta, readBuildMeta } from './rag-build-store.js';
import { checkDensePool, type DensePoolCheck } from './rag-eval-dense.js';
import {
  chunkBody,
  fmtScoreSummary,
  goldRank,
  goldsOf,
  parseQuerySet,
  percentile,
  rankOfExpected,
  scoreQuery,
  summarizeScores,
  type Gold,
  type GoldOutcome,
  type QueryScore,
  type SetQuery,
} from './rag-eval-metrics.js';

const SET_KS = [5, 8, 12, 20, 50];
const DENSE_LIMIT = 50;
const EMPTY_SUMMARY = { n: 0, recall: 0, mrr: 0, hit: 0 };

interface QueryResult {
  query: string;
  kind: string;
  skipped: boolean;
  golds: { path: string; anchor?: string; inStore: boolean; rank50: number | null }[];
  byK: Record<string, { score: QueryScore | null; ms: number }>;
  dense?: DensePoolCheck;
}

function loadQuerySet(path: string): SetQuery[] {
  return parseQuerySet(JSON.parse(readFileSync(path, 'utf8')), path);
}

interface SetSummary {
  perKind: Record<string, Record<string, ReturnType<typeof summarizeScores>>>;
  all: Record<string, ReturnType<typeof summarizeScores>>;
  skipped: number;
  searchMs: Record<string, { p50: number; p95: number }>;
  dense: {
    n: number;
    overlap: number;
    indexRows: number;
    exactRows: number;
    hnswPlan: number;
  } | null;
}

function summarizeSet(results: QueryResult[]): SetSummary {
  const live = results.filter((r) => !r.skipped);
  const kinds = [...new Set(live.map((r) => r.kind))];
  const scoresAt = (rs: QueryResult[], k: number) =>
    summarizeScores(rs.flatMap((r) => (r.byK[k]?.score ? [r.byK[k].score as QueryScore] : [])));
  const perK = (rs: QueryResult[]) =>
    Object.fromEntries(SET_KS.map((k) => [String(k), scoresAt(rs, k)]));
  const dense = live.flatMap((r) => (r.dense ? [r.dense] : []));
  const mean = (f: (d: DensePoolCheck) => number) =>
    dense.reduce((a, d) => a + f(d), 0) / (dense.length || 1);
  return {
    perKind: Object.fromEntries(
      kinds.map((kind) => [kind, perK(live.filter((r) => r.kind === kind))]),
    ),
    all: perK(live),
    skipped: results.length - live.length,
    searchMs: Object.fromEntries(
      SET_KS.map((k) => {
        const ms = live.map((r) => r.byK[k]?.ms ?? 0);
        return [String(k), { p50: percentile(ms, 50), p95: percentile(ms, 95) }];
      }),
    ),
    dense: dense.length
      ? {
          n: dense.length,
          overlap: mean((d) => d.overlap),
          indexRows: mean((d) => d.indexRows),
          exactRows: mean((d) => d.exactRows),
          hnswPlan: dense.filter((d) => d.defaultUsesHnsw).length,
        }
      : null,
  };
}

function fmtSetSummary(s: SetSummary): string[] {
  const lines: string[] = [];
  for (const [kind, perK] of Object.entries({ ...s.perKind, OVERALL: s.all })) {
    for (const k of SET_KS) lines.push(fmtScoreSummary(kind, k, perK[String(k)] ?? EMPTY_SUMMARY));
  }
  if (s.skipped > 0) lines.push(`skipped queries (no gold in store): ${s.skipped}`);
  for (const k of SET_KS) {
    const t = s.searchMs[String(k)] ?? { p50: 0, p95: 0 };
    lines.push(`search time k=${k}: p50=${t.p50.toFixed(1)}ms p95=${t.p95.toFixed(1)}ms`);
  }
  if (s.dense) {
    lines.push(
      `dense pool @${DENSE_LIMIT} (n=${s.dense.n}): index rows=${s.dense.indexRows.toFixed(1)} ` +
        `exact rows=${s.dense.exactRows.toFixed(1)} overlap@${DENSE_LIMIT}=${s.dense.overlap.toFixed(3)} ` +
        `default plan uses idx_rag_vector_hnsw in ${s.dense.hnswPlan}/${s.dense.n}`,
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const querySetPath = process.env.RAG_QUERY_SET;
  const query = process.env.RAG_QUERY;
  if (!query && !querySetPath) {
    console.error('RAG_QUERY or RAG_QUERY_SET is required');
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const projectName = process.env.RAG_PROJECT || 'default';
  const prefs: RagToolingPrefs = {
    ragMode: (process.env.RAG_MODE || 'internal') as RagMode,
    ragConnectionString: process.env.RAG_CONN || null,
    ollamaUrl: process.env.RAG_OLLAMA_URL || 'http://ollama:11434',
    embeddingModel: process.env.RAG_MODEL || 'qwen3-embedding:4b',
    embeddingDimensions: Number(process.env.RAG_DIMS || 2560),
  };
  const topK = Number(process.env.RAG_TOPK || 10);
  const expected = process.env.RAG_EXPECTED || '';
  const repositoryId = process.env.RAG_REPOSITORY_ID || undefined;
  const denseCheck = process.env.RAG_DENSE_CHECK === '1';
  const outPath = process.env.RAG_OUT || '';
  const forceLexicalOnly = process.env.RAG_LEXICAL_ONLY === '1';
  const identifierSearch = process.env.RAG_IDENTIFIER_SEARCH !== '0';
  const runbookBoost = Number(process.env.RAG_RUNBOOK_BOOST || 1);
  const querySet = querySetPath ? loadQuerySet(querySetPath) : null;

  const db = createDatabase(dbUrl);
  let conn: RagConnection | null;
  if (prefs.ragMode === 'internal') {
    const dbName = ragDatabaseName(projectName);
    conn = await openExistingRagDatabase(db, dbName, prefs.embeddingDimensions);
    if (!conn) {
      console.error(`database ${dbName} does not exist; refusing to create it`);
      process.exit(1);
    }
  } else {
    conn = await resolveRagConnection(prefs, db, projectName);
    if (!conn) {
      console.error(`rag disabled for mode=${prefs.ragMode}`);
      process.exit(1);
    }
  }
  const openConn = conn;
  // ragHybridSearch ranks lexically on a store with no vector column, whatever the embed returns.
  const storeHasVector =
    (
      await openConn.pg.unsafe(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'vector'`,
        [RAG_TABLE],
      )
    ).length > 0;
  const runLexicalOnly = forceLexicalOnly || !storeHasVector;
  const recorded = forceLexicalOnly ? null : await readBuildMeta(openConn.pg);
  if (recorded) {
    const decision = decideBuildMeta(recorded, true, {
      model: prefs.embeddingModel ?? '',
      dims: prefs.embeddingDimensions,
    });
    if (decision.action === 'refuse') {
      console.error(`refused: ${decision.reason}`);
      process.exit(1);
    }
  }

  async function embed(text: string): Promise<number[] | null> {
    if (forceLexicalOnly) return null;
    const vec = await embedQueryOrNull(text, {
      ollamaUrl: prefs.ollamaUrl,
      model: prefs.embeddingModel,
      dimensions: prefs.embeddingDimensions,
    });
    if (vec === null) console.error('query could not be embedded: ranking on full text alone');
    return vec;
  }

  async function search(
    text: string,
    vec: number[] | null,
    k: number,
  ): Promise<{ hits: RagSearchHit[]; lexicalOnly: boolean; ms: number }> {
    const t0 = performance.now();
    const hits = await ragHybridSearch(
      openConn,
      vec ?? [],
      text,
      { topK: k, runbookBoost, lexicalOnly: vec === null, identifierSearch },
      undefined,
      repositoryId,
    );
    return {
      hits,
      lexicalOnly: vec === null || !storeHasVector,
      ms: performance.now() - t0,
    };
  }

  async function goldInStore(g: Gold): Promise<boolean> {
    const params: string[] = g.anchor === undefined ? [g.path] : [g.path, g.anchor];
    const cond =
      g.anchor === undefined
        ? `position($1 in source_path) > 0`
        : `source_path = $1 AND position($2 in content) > 0`;
    const repo = repositoryId ? ` AND repository_id = $${params.length + 1}` : '';
    if (repositoryId) params.push(repositoryId);
    const rows = (await openConn.pg.unsafe(
      `SELECT source_path, content FROM ${RAG_TABLE} WHERE ${cond}${repo}${g.anchor === undefined ? ' LIMIT 1' : ''}`,
      params,
    )) as unknown as { source_path: string; content: string }[];
    const anchor = g.anchor;
    if (anchor === undefined) return rows.length > 0;
    return rows.some((r) => chunkBody(r.content, r.source_path).includes(anchor));
  }

  const settings =
    `lexicalOnly=${runLexicalOnly} identifierSearch=${identifierSearch} ` +
    `runbookBoost=${runbookBoost} topK=${topK} repositoryId=${repositoryId ?? '-'}`;

  if (querySet) {
    console.log(`Project: ${projectName} (mode=${prefs.ragMode})   ${settings}\n`);
    const results: QueryResult[] = [];
    for (const q of querySet) {
      const golds = goldsOf(q);
      const inStore = await Promise.all(golds.map(goldInStore));
      const vec = await embed(q.query);
      const result: QueryResult = {
        query: q.query,
        kind: q.kind,
        skipped: !inStore.some(Boolean),
        golds: golds.map((g, i) => ({ ...g, inStore: inStore[i] === true, rank50: null })),
        byK: {},
      };
      results.push(result);
      golds.forEach((g, i) => {
        if (!inStore[i])
          console.log(`[${q.kind}] not in store  ${JSON.stringify(g)}  <- ${q.query}`);
      });
      if (result.skipped) {
        console.log(`[${q.kind}] SKIPPED: no gold is in the store  <- ${q.query}`);
        continue;
      }
      for (const k of SET_KS) {
        const { hits, lexicalOnly, ms } = await search(q.query, vec, k);
        if (lexicalOnly && !runLexicalOnly) {
          // One degraded query would mix lexical-only ranks into a hybrid summary.
          console.error(`query fell back to lexical-only; aborting the set: ${q.query}`);
          await openConn.close();
          process.exit(1);
        }
        const ranks = golds.map((g) => goldRank(hits, g));
        if (k === SET_KS[SET_KS.length - 1]) {
          result.golds.forEach((g, i) => {
            g.rank50 = ranks[i] ?? null;
          });
        }
        const outcomes: GoldOutcome[] = ranks.map((rank, i) => ({
          rank,
          inStore: inStore[i] === true,
        }));
        result.byK[k] = { score: scoreQuery(outcomes, k), ms };
      }
      const shown = result.golds
        .map((g) => (!g.inStore ? 'not in store' : g.rank50 === null ? 'miss' : `rank ${g.rank50}`))
        .join(', ');
      console.log(`[${q.kind}] ${shown} (page ${SET_KS[SET_KS.length - 1]})  <- ${q.query}`);
      if (denseCheck) {
        if (vec === null || !storeHasVector) {
          console.error(
            'RAG_DENSE_CHECK skipped for a query with no embedding or a store with no vector',
          );
        } else {
          result.dense = await checkDensePool(
            openConn.pg,
            vectorLiteral(vec),
            openConn.embeddingDimensions,
            DENSE_LIMIT,
            repositoryId,
          );
        }
      }
    }
    console.log('');
    const summary = summarizeSet(results);
    const lines = fmtSetSummary(summary);
    for (const line of lines) console.log(line);
    if (outPath) {
      writeFileSync(
        outPath,
        JSON.stringify({ project: projectName, settings, results, summary }, null, 2),
      );
    }
  } else if (query) {
    const { hits } = await search(query, await embed(query), topK);
    console.log(`\nQuery:   ${query}`);
    console.log(
      `Project: ${projectName} (mode=${prefs.ragMode})   runbookBoost: ${runbookBoost}   hits: ${hits.length}\n`,
    );
    hits.forEach((h, i) => {
      const mark = expected && h.sourcePath.includes(expected) ? '   <== EXPECTED' : '';
      console.log(
        `${String(i + 1).padStart(2)}. [${h.sourceType}] rrf=${h.rrf.toFixed(4)} ` +
          `dense=${h.denseSim.toFixed(3)} ts=${h.tsNorm.toFixed(3)} hybrid=${h.hybrid.toFixed(3)}  ` +
          `${h.sourcePath} #${h.sectionId}${mark}`,
      );
    });
    if (expected) {
      const rank = rankOfExpected(hits, expected);
      console.log(`\nExpected "${expected}": ${rank !== null ? `rank ${rank}` : 'NOT in top-k'}`);
    }
  }

  await openConn.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
