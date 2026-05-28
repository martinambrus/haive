import { type RagConnection, RAG_TABLE } from './connection.js';
import { vectorLiteral } from './embed.js';

/** Tunable knobs for hybrid retrieval. Defaults are conservative and chosen so
 *  a dense-strong / lexical-zero code hit still clears the gate — the exact
 *  failure mode the legacy `0.7*dense + 0.3*bm25` vs 0.7-gate scheme suffered.
 *  Recalibrate with packages/worker/scripts/rag-eval.ts against a populated DB. */
export interface RagSearchConfig {
  /** Candidate pool size pulled from each of the dense and lexical rankers
   *  before fusion. */
  candidatePool: number;
  /** RRF constant k. Larger = flatter rank weighting. 60 is the common default. */
  rrfK: number;
  /** Minimum dense cosine similarity for a row to be eligible when it has NO
   *  lexical match. Rows with any lexical match (ts > 0) bypass this floor. */
  denseFloor: number;
  /** Number of fused results returned to the agent. */
  topK: number;
  /** Display-only weighted-sum weights (the `hybrid` field). Not used for
   *  ranking or gating — RRF does both. Kept for tuning visibility. */
  denseWeight: number;
  lexWeight: number;
}

export const DEFAULT_RAG_SEARCH_CONFIG: RagSearchConfig = {
  candidatePool: 50,
  rrfK: 60,
  denseFloor: 0.3,
  topK: 8,
  denseWeight: 0.7,
  lexWeight: 0.3,
};

export interface RagSearchHit {
  sourcePath: string;
  sectionId: string;
  chunkIndex: number;
  sourceType: string;
  content: string;
  /** Cosine similarity in ~[0,1]. 0 when the row came only from the lexical
   *  ranker and the store has no vector column (jsonb fallback). */
  denseSim: number;
  /** ts_rank_cd squashed to [0,1] via ts/(ts+1). 0 when no lexical match. */
  tsNorm: number;
  /** Display-only weighted sum (denseWeight*denseSim + lexWeight*tsNorm). */
  hybrid: number;
  /** Reciprocal-rank-fusion score — the actual ranking signal. */
  rrf: number;
}

interface RawRow {
  source_path: string;
  section_id: string;
  chunk_index: number | string;
  source_type: string;
  content: string;
  dense_sim: number | string | null;
  ts_norm: number | string | null;
  hybrid: number | string | null;
  rrf: number | string | null;
}

function num(v: number | string | null): number {
  if (v === null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function hasVectorColumn(conn: RagConnection): Promise<boolean> {
  const rows = (await conn.pg.unsafe(
    `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 AND column_name = 'vector'`,
    [RAG_TABLE],
  )) as unknown as Array<{ column_name: string }>;
  return rows.length > 0;
}

/** Hybrid dense + lexical retrieval over a project RAG database.
 *
 *  Ranking uses Reciprocal Rank Fusion of the dense (pgvector cosine) and
 *  lexical (Postgres FTS ts_rank_cd) rankers. RRF is the structural fix for the
 *  reported bug: a row that is strong in dense but absent from the lexical
 *  ranker still earns its full dense RRF contribution, so relevant code can
 *  never be capped below a gate by a zero lexical score. The gate is a relevance
 *  FLOOR on results (denseFloor OR any lexical match), not a "score < X -> grep"
 *  rule — callers should treat a non-empty result as "use RAG". */
export async function ragHybridSearch(
  conn: RagConnection,
  queryVec: number[],
  queryText: string,
  config: Partial<RagSearchConfig> = {},
): Promise<RagSearchHit[]> {
  const cfg = { ...DEFAULT_RAG_SEARCH_CONFIG, ...config };
  const usePgvector = await hasVectorColumn(conn);

  let rows: RawRow[];

  if (usePgvector) {
    const qv = vectorLiteral(queryVec);
    rows = (await conn.pg.unsafe(
      `
      WITH q AS (
        SELECT $1::vector AS qv, plainto_tsquery('english', $2) AS qq
      ),
      dense AS (
        SELECT id,
               row_number() OVER (ORDER BY vector <=> (SELECT qv FROM q)) AS d_rank,
               1 - (vector <=> (SELECT qv FROM q)) AS dense_sim
        FROM ${RAG_TABLE}
        ORDER BY vector <=> (SELECT qv FROM q)
        LIMIT $3
      ),
      lex AS (
        SELECT id,
               row_number() OVER (
                 ORDER BY ts_rank_cd(content_tsv, (SELECT qq FROM q)) DESC
               ) AS l_rank,
               ts_rank_cd(content_tsv, (SELECT qq FROM q)) AS ts
        FROM ${RAG_TABLE}
        WHERE content_tsv @@ (SELECT qq FROM q)
        ORDER BY ts DESC
        LIMIT $3
      ),
      cand AS (
        SELECT id FROM dense
        UNION
        SELECT id FROM lex
      )
      SELECT
        e.source_path, e.section_id, e.chunk_index, e.source_type, e.content,
        COALESCE(d.dense_sim, 1 - (e.vector <=> (SELECT qv FROM q))) AS dense_sim,
        (COALESCE(l.ts, 0) / (COALESCE(l.ts, 0) + 1)) AS ts_norm,
        (
          $6 * COALESCE(d.dense_sim, 1 - (e.vector <=> (SELECT qv FROM q)))
          + $7 * (COALESCE(l.ts, 0) / (COALESCE(l.ts, 0) + 1))
        ) AS hybrid,
        (
          CASE WHEN d.d_rank IS NOT NULL THEN 1.0 / ($4 + d.d_rank) ELSE 0 END
          + CASE WHEN l.l_rank IS NOT NULL THEN 1.0 / ($4 + l.l_rank) ELSE 0 END
        ) AS rrf
      FROM cand c
      JOIN ${RAG_TABLE} e ON e.id = c.id
      LEFT JOIN dense d ON d.id = c.id
      LEFT JOIN lex l ON l.id = c.id
      WHERE COALESCE(d.dense_sim, 1 - (e.vector <=> (SELECT qv FROM q))) >= $5
         OR COALESCE(l.ts, 0) > 0
      ORDER BY rrf DESC
      LIMIT $8
      `,
      [
        qv,
        queryText,
        cfg.candidatePool,
        cfg.rrfK,
        cfg.denseFloor,
        cfg.denseWeight,
        cfg.lexWeight,
        cfg.topK,
      ],
    )) as unknown as RawRow[];
  } else {
    // jsonb-fallback store has no vector column: lexical-only ranking.
    rows = (await conn.pg.unsafe(
      `
      WITH q AS (SELECT plainto_tsquery('english', $1) AS qq)
      SELECT
        source_path, section_id, chunk_index, source_type, content,
        0 AS dense_sim,
        (ts_rank_cd(content_tsv, (SELECT qq FROM q))
          / (ts_rank_cd(content_tsv, (SELECT qq FROM q)) + 1)) AS ts_norm,
        (ts_rank_cd(content_tsv, (SELECT qq FROM q))
          / (ts_rank_cd(content_tsv, (SELECT qq FROM q)) + 1)) AS hybrid,
        1.0 / ($2 + row_number() OVER (
          ORDER BY ts_rank_cd(content_tsv, (SELECT qq FROM q)) DESC
        )) AS rrf
      FROM ${RAG_TABLE}
      WHERE content_tsv @@ (SELECT qq FROM q)
      ORDER BY rrf DESC
      LIMIT $3
      `,
      [queryText, cfg.rrfK, cfg.topK],
    )) as unknown as RawRow[];
  }

  return rows.map((r) => ({
    sourcePath: r.source_path,
    sectionId: r.section_id,
    chunkIndex: typeof r.chunk_index === 'number' ? r.chunk_index : Number(r.chunk_index),
    sourceType: r.source_type,
    content: r.content,
    denseSim: num(r.dense_sim),
    tsNorm: num(r.ts_norm),
    hybrid: num(r.hybrid),
    rrf: num(r.rrf),
  }));
}
