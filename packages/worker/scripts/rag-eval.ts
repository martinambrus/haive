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
 *                 row in the store is a miss and remains in the denominator.
 *                 One search per page size in {5, 8, 12, 20, 50} reusing one embedding; prints
 *                 recall/MRR per class, language, split and cell, rubric coverage for overview, and
 *                 no-answer false-positive rate. All metrics carry seeded query-bootstrap CIs.
 *   RAG_MANIFEST  manifest JSON path (default: manifest.json next to RAG_QUERY_SET).
 *                 Fingerprint is computed from manifest + query bytes; any edit invalidates baselines.
 *                 An absent default manifest permits standalone, non-comparable results.
 *   RAG_COMPACT  1 writes minified query records without summaries, hits, ms or dense dumps
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
import path from 'node:path';
import { readTextNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { fixtureFingerprint } from './rag-eval-fixture.js';
import { createDatabase } from '@haive/database';
import {
  embedQueryOrNull,
  DEFAULT_RAG_SEARCH_CONFIG,
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
import { checkDensePool } from './rag-eval-dense.js';
import {
  chunkBody,
  goldRank,
  goldsOf,
  parseQuerySet,
  rankOfExpected,
  scoreQuery,
  type Gold,
  type GoldOutcome,
} from './rag-eval-metrics.js';

import {
  compactRun,
  METRIC_VERSION,
  SET_KS,
  noAnswerScore,
  overviewCoverage,
  summarizeRun,
  type QueryResult,
  type EvalSettings,
} from './rag-eval-report.js';

const DENSE_LIMIT = 50;
// Operator-supplied files may live outside the checkout. Hold every component,
// including the parent directories, rather than trusting a path-based open.
async function readInputText(filename: string): Promise<string | null> {
  const full = path.resolve(filename);
  return await readTextNoFollow(path.parse(full).root, full.slice(path.parse(full).root.length), {
    strict: true,
  });
}

async function loadQuerySet(filename: string) {
  const queryText = await readInputText(filename);
  if (queryText === null) throw new Error(`cannot read query set: ${filename}`);
  const queries = parseQuerySet(JSON.parse(queryText), filename);
  const explicitManifest = process.env.RAG_MANIFEST;
  const manifestPath = explicitManifest || path.join(path.dirname(filename), 'manifest.json');
  const manifestText = await readInputText(manifestPath);
  if (manifestText === null) {
    if (!explicitManifest) return { queries, fingerprint: '' };
    throw new Error(`cannot read RAG_MANIFEST: ${manifestPath}`);
  }
  return { queries, fingerprint: fixtureFingerprint(manifestText, queryText) };
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
  const loaded = querySetPath ? await loadQuerySet(querySetPath) : null;
  const querySet = loaded?.queries;
  const fingerprint = loaded?.fingerprint ?? '';

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
    // RAG_CONN is typed by the operator on this command line, not stored data.
    conn = await resolveRagConnection(prefs, db, projectName, { trustedTarget: true });
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
  const { topK: _defaultTopK, ...searchDefaults } = DEFAULT_RAG_SEARCH_CONFIG;
  const settings: EvalSettings = {
    embeddingModel: prefs.embeddingModel!,
    embeddingDimensions: openConn.embeddingDimensions,
    ks: [...SET_KS],
    repositoryScoped: repositoryId !== undefined,
    search: {
      ...searchDefaults,
      lexicalOnly: runLexicalOnly,
      identifierSearch,
      runbookBoost,
    },
  };
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
    // The operator typed this URL and this process has no config store, so the private-address guard does not apply.
    const vec = await embedQueryOrNull(text, {
      ollamaUrl: prefs.ollamaUrl,
      model: prefs.embeddingModel,
      dimensions: prefs.embeddingDimensions,
      fetchFn: fetch,
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
      { ...settings.search, topK: k, lexicalOnly: vec === null },
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

  const settingsLabel =
    `lexicalOnly=${runLexicalOnly} identifierSearch=${identifierSearch} ` +
    `runbookBoost=${runbookBoost} topK=${topK} repositoryId=${repositoryId ?? '-'}`;

  if (querySet) {
    console.log(`Project: ${projectName} (mode=${prefs.ragMode})   ${settingsLabel}\n`);
    const results: QueryResult[] = [];
    for (const q of querySet) {
      const golds = goldsOf(q);
      const inStore = await Promise.all(golds.map(goldInStore));
      const vec = await embed(q.query);
      const result: QueryResult = {
        id: q.id ?? `legacy-${results.length + 1}`,
        query: q.query,
        kind: q.kind,
        language: q.language ?? 'unknown',
        split: q.split ?? 'unspecified',
        labels: JSON.stringify({
          gold: q.gold,
          expected: q.expected,
          rubric: q.rubric,
          reason: q.reason,
        }),
        golds: golds.map((g, i) => ({ ...g, inStore: inStore[i] === true, rank50: null })),
        byK: {},
      };
      results.push(result);
      golds.forEach((g, i) => {
        if (!inStore[i])
          console.log(`[${q.kind}] not in store  ${JSON.stringify(g)}  <- ${q.query}`);
      });
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
          result.golds!.forEach((g, i) => {
            g.rank50 = ranks[i] ?? null;
          });
        }
        const outcomes: GoldOutcome[] = ranks.map((rank, i) => ({
          rank,
          inStore: inStore[i] === true,
        }));
        result.byK[k] = {
          score: scoreQuery(outcomes, k),
          ms,
          topDenseSim: Math.max(0, ...hits.map((h) => h.denseSim)),
          topLexical: !!hits[0] && (hits[0].ranks?.fts != null || hits[0].ranks?.ident != null),
          hits: hits.map(({ sourcePath, content, rrf, denseSim }) => ({
            sourcePath,
            content,
            rrf,
            denseSim,
          })),
          overview: overviewCoverage(q, hits),
          noAnswer: q.kind === 'no-answer' ? noAnswerScore(hits) : null,
        };
      }
      const shown = result
        .golds!.map((g) =>
          !g.inStore ? 'not in store' : g.rank50 === null ? 'miss' : `rank ${g.rank50}`,
        )
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
    const summary = summarizeRun(results);
    console.log(JSON.stringify(summary, null, 2));
    if (outPath) {
      const run = { metricVersion: METRIC_VERSION, fixture: fingerprint, settings, results };
      const compact = process.env.RAG_COMPACT === '1';
      const fullOut = path.resolve(outPath);
      await writeFileNoFollow(
        path.parse(fullOut).root,
        fullOut.slice(path.parse(fullOut).root.length),
        JSON.stringify(
          compact
            ? compactRun(run)
            : {
                ...run,
                project: projectName,
                summary,
              },
          null,
          compact ? undefined : 2,
        ) + '\n',
        { mode: 'replace-atomic' },
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
