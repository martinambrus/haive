/**
 * RAG retrieval eval / tuning harness.
 *
 * Runs a single hybrid query against a project's RAG database and prints the
 * dense / lexical / hybrid / RRF scores and ranks, so the scoring knobs
 * (DEFAULT_RAG_SEARCH_CONFIG in @haive/shared/rag) can be calibrated against
 * real data. Also serves as the manual regression check for the reported bug:
 * a genuinely-relevant code hit must clear the gate and rank in the top-k even
 * when its lexical score is ~0.
 *
 * Run inside the worker container (has DATABASE_URL + ollama reachable):
 *   docker exec -e RAG_QUERY="task list exposed filters views" \
 *     -e RAG_PROJECT="myproject" -e RAG_EXPECTED="views_query_alter" \
 *     haive-worker pnpm --filter @haive/worker exec tsx scripts/rag-eval.ts
 *
 * Env:
 *   RAG_QUERY     (required) the search query
 *   RAG_PROJECT   project name (internal mode db = haive_rag_<project>); default "default"
 *   RAG_MODE      internal | external | ddev   (default internal)
 *   RAG_CONN      connection string for external/ddev
 *   RAG_OLLAMA_URL  default http://ollama:11434
 *   RAG_MODEL     default qwen3-embedding:4b
 *   RAG_DIMS      default 2560
 *   RAG_TOPK      default 10
 *   RAG_EXPECTED  optional substring of an expected source_path to report its rank
 */
import { createDatabase } from '@haive/database';
import {
  embedQuery,
  ragHybridSearch,
  resolveRagConnection,
  type RagMode,
  type RagToolingPrefs,
} from '@haive/shared/rag';

async function main(): Promise<void> {
  const query = process.env.RAG_QUERY;
  if (!query) {
    console.error('RAG_QUERY is required');
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

  const db = createDatabase(dbUrl);
  const conn = await resolveRagConnection(prefs, db, projectName);
  if (!conn) {
    console.error(`rag disabled for mode=${prefs.ragMode}`);
    process.exit(1);
  }

  const vec = await embedQuery(query, {
    ollamaUrl: prefs.ollamaUrl,
    model: prefs.embeddingModel,
    dimensions: prefs.embeddingDimensions,
  });
  const runbookBoost = Number(process.env.RAG_RUNBOOK_BOOST || 1);
  const hits = await ragHybridSearch(conn, vec, query, { topK, runbookBoost });

  console.log(`\nQuery:   ${query}`);
  console.log(
    `Project: ${projectName} (mode=${prefs.ragMode})   runbookBoost: ${runbookBoost}   hits: ${hits.length}\n`,
  );
  hits.forEach((h, i) => {
    const mark = expected && h.sourcePath.includes(expected) ? '   <== EXPECTED' : '';
    console.log(
      `${String(i + 1).padStart(2)}. rrf=${h.rrf.toFixed(4)} dense=${h.denseSim.toFixed(3)} ` +
        `ts=${h.tsNorm.toFixed(3)} hybrid=${h.hybrid.toFixed(3)}  ` +
        `${h.sourcePath} #${h.sectionId}${mark}`,
    );
  });
  if (expected) {
    const rank = hits.findIndex((h) => h.sourcePath.includes(expected));
    console.log(`\nExpected "${expected}": ${rank >= 0 ? `rank ${rank + 1}` : 'NOT in top-k'}`);
  }

  await conn.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
