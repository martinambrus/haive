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
   *  lexical match. Rows with any lexical match (ts > 0) bypass this floor.
   *  This is the floor for KB / non-code chunks. */
  denseFloor: number;
  /** Dense floor for `source_type='code'` chunks. Code embeds further from
   *  natural-language queries than prose KB, so it needs a lower floor to clear
   *  the gate; KB stays at `denseFloor` so weak prose matches aren't admitted.
   *  Starting point — recalibrate with worker/scripts/rag-eval.ts against the
   *  new rag_query_log stats. */
  codeDenseFloor: number;
  /** Number of fused results returned to the agent. */
  topK: number;
  /** Display-only weighted-sum weights (the `hybrid` field). Not used for
   *  ranking or gating — RRF does both. Kept for tuning visibility. */
  denseWeight: number;
  lexWeight: number;
  /** Final-RRF multiplier applied ONLY to `source_type='runbook'` rows (bug
   *  investigations). >1 boosts run-books (bug-fix tasks), <1 demotes them
   *  (new-feature tasks), 1 = neutral / no run-books present. Other source types
   *  are untouched. Tunable with scripts/rag-eval.ts once run-books accumulate. */
  runbookBoost: number;
}

export const DEFAULT_RAG_SEARCH_CONFIG: RagSearchConfig = {
  candidatePool: 50,
  rrfK: 60,
  denseFloor: 0.3,
  codeDenseFloor: 0.2,
  topK: 8,
  denseWeight: 0.7,
  lexWeight: 0.3,
  runbookBoost: 1.0,
};

/** Per-task-type run-book RRF multipliers applied by the /rag/search route.
 *  Calibrated with scripts/rag-eval.ts against seeded run-books: 1.5 clusters the
 *  relevant run-books near the top for a bug query without dragging irrelevant ones
 *  in (2.5 over-pulls); 0.5 demotes them for feature tasks ("present but lower
 *  priority"). 1.0 (neutral) is the default when a task type is unknown. */
export const RUNBOOK_BOOST_BUGFIX = 1.5;
export const RUNBOOK_BOOST_FEATURE = 0.5;

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
  /** Which store the hit came from. Set by the /rag/search route when merging
   *  per-repo (local) and global KB results; undefined for a single-store call. */
  scope?: 'local' | 'global';
}

/** Optional metadata filter for the GLOBAL KB store: restricts candidates to a
 *  namespace and to chunks whose version/variant facets are compatible with the
 *  current project (plan §3.3/§3.4). Omitted for per-repo searches, which then
 *  run the original SQL byte-for-byte. */
export interface RagFacetFilter {
  namespace: string;
  /** Per-dimension allowed values for the CURRENT project. A chunk matches a
   *  dimension iff it does not constrain that dimension OR its set overlaps the
   *  project's; an empty project array excludes chunks that constrain it. */
  facets: Record<string, string[]>;
}

const FACET_FILTER_DIMENSIONS = [
  'framework',
  'frameworkMajor',
  'language',
  'phpMajor',
  'nodeMajor',
  'database',
  'dbMajor',
  'packages',
  'tags',
] as const;

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

/** Build a Postgres text[] array literal from string values, e.g.
 *  ['drupal','drupal7'] -> {"drupal","drupal7"}, [] -> {}. Passed as a bound
 *  param and cast `$n::text[]` so we never rely on driver array binding. */
function pgTextArrayLiteral(values: string[]): string {
  if (!values || values.length === 0) return '{}';
  const escaped = values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}

/** Namespace + per-dimension facet predicate shared by the dense and lexical
 *  candidate CTEs, plus its positional params beginning at `$startIdx`. The same
 *  param indexes are referenced from both CTEs (Postgres allows reuse). */
function buildFacetClause(
  filter: RagFacetFilter,
  startIdx: number,
): { core: string; params: string[] } {
  const params: string[] = [filter.namespace];
  const parts: string[] = [`namespace = $${startIdx}`];
  let n = startIdx + 1;
  for (const dim of FACET_FILTER_DIMENSIONS) {
    params.push(pgTextArrayLiteral(filter.facets[dim] ?? []));
    parts.push(
      `(NOT (facets ? '${dim}') OR jsonb_array_length(facets->'${dim}') = 0 OR (facets->'${dim}') ?| $${n}::text[])`,
    );
    n += 1;
  }
  return { core: parts.join('\n          AND '), params };
}

/** Hybrid dense + lexical retrieval over a project RAG database.
 *
 *  Ranking uses Reciprocal Rank Fusion of the dense (pgvector cosine) and
 *  lexical (Postgres FTS ts_rank_cd) rankers. RRF is the structural fix for the
 *  reported bug: a row that is strong in dense but absent from the lexical
 *  ranker still earns its full dense RRF contribution, so relevant code can
 *  never be capped below a gate by a zero lexical score. The gate is a relevance
 *  FLOOR on results (denseFloor OR any lexical match), not a "score < X -> grep"
 *  rule — callers should treat a non-empty result as "use RAG".
 *
 *  `filter` is the GLOBAL-KB-only namespace + facet predicate (plan §3.4). It is
 *  applied INSIDE the dense and lexical candidate CTEs (before LIMIT) so the
 *  candidate pool is not starved by post-filtering.
 *
 *  `repositoryId` is the LOCAL per-repo scope: when set (internal mode), every
 *  candidate CTE is filtered to that repository_id so co-tenant repos sharing a
 *  project-name-keyed RAG database never leak into each other's results. Omit it
 *  for the global KB (which is cross-project by design). */
export async function ragHybridSearch(
  conn: RagConnection,
  queryVec: number[],
  queryText: string,
  config: Partial<RagSearchConfig> = {},
  filter?: RagFacetFilter,
  repositoryId?: string,
): Promise<RagSearchHit[]> {
  const cfg = { ...DEFAULT_RAG_SEARCH_CONFIG, ...config };
  const usePgvector = await hasVectorColumn(conn);
  const dims = conn.embeddingDimensions;

  let rows: RawRow[];

  if (usePgvector) {
    const qv = vectorLiteral(queryVec);
    // Base params are $1..$9; facet params (if any) start at $10; the run-book
    // boost param follows the facets; the optional repository_id filter is last.
    const fc = filter ? buildFacetClause(filter, 10) : null;
    const boostParam = 9 + (fc?.params.length ?? 0) + 1;
    const repoParam = repositoryId ? boostParam + 1 : 0;
    const repoCond = repositoryId ? `repository_id = $${repoParam}` : null;
    // The dense and lexical candidate CTEs share the same namespace + facet +
    // repository predicates. Local search passes repositoryId (per-repo isolation);
    // the global KB passes the facet filter. They are mutually exclusive today but
    // combine cleanly (AND) if both are ever supplied.
    const conds = [fc?.core, repoCond].filter(Boolean) as string[];
    const denseWhere = conds.length ? `WHERE ${conds.join('\n          AND ')}` : '';
    const lexExtra = conds.map((c) => `\n          AND ${c}`).join('');
    // pgvector's HNSW index (idx_rag_vector_hnsw) is built on the `vector::halfvec(dims)`
    // cast, so the dense candidate CTE must ORDER BY the SAME cast to use it — an
    // uncast `vector <=>` falls back to a full sequential scan. The outer `dense`
    // CTE re-derives d_rank over the returned pool and recomputes dense_sim at full
    // `vector` precision for the relevance gate.
    //
    // We deliberately do NOT raise hnsw.ef_search: on modest tables that inflates
    // the planner's estimated HNSW cost past a plain seq-scan+sort and reverts the
    // dense CTE to a full scan (measured: ef_search=100 -> 430ms seq scan vs the
    // default's 5ms index scan). At the default ef_search the planner keeps the
    // index, and its candidate count is ample for the RRF fusion below. A selective
    // repo/facet filter is served by a bitmap index scan + exact sort (the planner's
    // own choice) — fast and exact — so no iterative_scan GUC (and thus no
    // transaction wrapper) is needed.
    const sqlText = `
      WITH q AS (
        SELECT $1::vector AS qv, ($1::vector)::halfvec(${dims}) AS qvh,
               plainto_tsquery('english', $2) AS qq
      ),
      dense_c AS (
        SELECT id, vector,
               (vector::halfvec(${dims})) <=> (SELECT qvh FROM q) AS hd
        FROM ${RAG_TABLE}
        ${denseWhere}
        ORDER BY (vector::halfvec(${dims})) <=> (SELECT qvh FROM q)
        LIMIT $3
      ),
      dense AS (
        SELECT id,
               row_number() OVER (ORDER BY hd) AS d_rank,
               1 - (vector <=> (SELECT qv FROM q)) AS dense_sim
        FROM dense_c
      ),
      lex AS (
        SELECT id,
               row_number() OVER (
                 ORDER BY ts_rank_cd(content_tsv, (SELECT qq FROM q)) DESC
               ) AS l_rank,
               ts_rank_cd(content_tsv, (SELECT qq FROM q)) AS ts
        FROM ${RAG_TABLE}
        WHERE content_tsv @@ (SELECT qq FROM q)${lexExtra}
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
          (
            CASE WHEN d.d_rank IS NOT NULL THEN 1.0 / ($4 + d.d_rank) ELSE 0 END
            + CASE WHEN l.l_rank IS NOT NULL THEN 1.0 / ($4 + l.l_rank) ELSE 0 END
          ) * (CASE WHEN e.source_type = 'runbook' THEN $${boostParam}::double precision ELSE 1 END)
        ) AS rrf
      FROM cand c
      JOIN ${RAG_TABLE} e ON e.id = c.id
      LEFT JOIN dense d ON d.id = c.id
      LEFT JOIN lex l ON l.id = c.id
      WHERE COALESCE(d.dense_sim, 1 - (e.vector <=> (SELECT qv FROM q)))
              >= (CASE WHEN e.source_type = 'code' THEN $9::double precision
                       ELSE $5::double precision END)
         OR COALESCE(l.ts, 0) > 0
      ORDER BY rrf DESC
      LIMIT $8
      `;
    const params = [
      qv,
      queryText,
      cfg.candidatePool,
      cfg.rrfK,
      cfg.denseFloor,
      cfg.denseWeight,
      cfg.lexWeight,
      cfg.topK,
      cfg.codeDenseFloor,
      ...(fc?.params ?? []),
      cfg.runbookBoost,
      ...(repositoryId ? [repositoryId] : []),
    ];
    rows = (await conn.pg.unsafe(sqlText, params)) as unknown as RawRow[];
  } else {
    // jsonb-fallback store has no vector column: lexical-only ranking.
    // Base params are $1..$3; facet params (if any) start at $4; the run-book
    // boost follows the facets; the optional repository_id filter is last.
    const fc = filter ? buildFacetClause(filter, 4) : null;
    const boostParamJ = 3 + (fc?.params.length ?? 0) + 1;
    const repoParamJ = repositoryId ? boostParamJ + 1 : 0;
    const conds = [fc?.core, repositoryId ? `repository_id = $${repoParamJ}` : null].filter(
      Boolean,
    ) as string[];
    const lexExtra = conds.map((c) => ` AND ${c}`).join('');
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
        (1.0 / ($2 + row_number() OVER (
          ORDER BY ts_rank_cd(content_tsv, (SELECT qq FROM q)) DESC
        ))) * (CASE WHEN source_type = 'runbook' THEN $${boostParamJ}::double precision ELSE 1 END) AS rrf
      FROM ${RAG_TABLE}
      WHERE content_tsv @@ (SELECT qq FROM q)${lexExtra}
      ORDER BY rrf DESC
      LIMIT $3
      `,
      [
        queryText,
        cfg.rrfK,
        cfg.topK,
        ...(fc?.params ?? []),
        cfg.runbookBoost,
        ...(repositoryId ? [repositoryId] : []),
      ],
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
