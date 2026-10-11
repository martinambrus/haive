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
 *   RAG_QUERY_SET path to JSON [{ "query", "expected" (source_path substring), "kind"? }]; prints
 *                 each expected rank, then n, MRR@k, hit@1, hit@5, hit@k per kind and overall
 *   RAG_LEXICAL_ONLY  1 skips the embed so the lexical-only branch runs
 *   RAG_IDENTIFIER_SEARCH  0 turns the identifier ranker off (default on)
 *   RAG_PROJECT   project name (internal mode db = haive_rag_<project>); default "default"
 *   RAG_MODE      internal | external | ddev   (default internal)
 *   RAG_CONN      connection string for external/ddev
 *   RAG_OLLAMA_URL  default http://ollama:11434
 *   RAG_MODEL     default qwen3-embedding:4b
 *   RAG_DIMS      default 2560
 *   RAG_TOPK      default 10
 *   RAG_EXPECTED  optional substring of an expected source_path to report its rank
 */
import { readFileSync } from 'node:fs';
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
} from '@haive/shared/rag';
import { fmtSummary, parseQuerySet, rankOfExpected, type SetQuery } from './rag-eval-metrics.js';

function loadQuerySet(path: string): SetQuery[] {
  return parseQuerySet(JSON.parse(readFileSync(path, 'utf8')), path);
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

  async function search(text: string): Promise<{ hits: RagSearchHit[]; lexicalOnly: boolean }> {
    const vec = forceLexicalOnly
      ? null
      : await embedQueryOrNull(text, {
          ollamaUrl: prefs.ollamaUrl,
          model: prefs.embeddingModel,
          dimensions: prefs.embeddingDimensions,
        });
    if (vec === null && !forceLexicalOnly) {
      console.error('query could not be embedded: ranking on full text alone');
    }
    const hits = await ragHybridSearch(openConn, vec ?? [], text, {
      topK,
      runbookBoost,
      lexicalOnly: vec === null,
      identifierSearch,
    });
    return { hits, lexicalOnly: vec === null || !storeHasVector };
  }

  const settings =
    `lexicalOnly=${runLexicalOnly} identifierSearch=${identifierSearch} ` +
    `runbookBoost=${runbookBoost} topK=${topK}`;

  if (querySet) {
    console.log(`Project: ${projectName} (mode=${prefs.ragMode})   ${settings}\n`);
    const byKind = new Map<string, (number | null)[]>();
    const all: (number | null)[] = [];
    for (const q of querySet) {
      const { hits, lexicalOnly } = await search(q.query);
      if (lexicalOnly && !runLexicalOnly) {
        // One degraded query would mix lexical-only ranks into a hybrid summary.
        console.error(`query fell back to lexical-only; aborting the set: ${q.query}`);
        await openConn.close();
        process.exit(1);
      }
      const rank = rankOfExpected(hits, q.expected);
      console.log(
        `[${q.kind}] ${rank === null ? 'NOT in top-k' : `rank ${rank}`}  "${q.expected}"  <- ${q.query}`,
      );
      all.push(rank);
      byKind.set(q.kind, [...(byKind.get(q.kind) ?? []), rank]);
    }
    console.log('');
    for (const [kind, ranks] of byKind) console.log(fmtSummary(kind, ranks, topK));
    console.log(fmtSummary('ALL', all, topK));
  } else if (query) {
    const { hits } = await search(query);
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
