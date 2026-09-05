import { type RagConnection, KNOWLEDGE_SOURCE_TYPES, RAG_TABLE } from './connection.js';
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
  /** Rank by full-text relevance ALONE, ignoring any stored vectors. Set for a
   *  repository whose owner accepted lexical-only RAG after embeddings failed:
   *  its rows carry hash vectors, which are not weak embeddings but noise, and a
   *  noisy dense half of the RRF fusion can outrank a genuine lexical hit. Reuses
   *  the branch a jsonb-only store already takes, so there is no second ranking
   *  implementation to keep in step. */
  lexicalOnly: boolean;
  /** Result slots held for knowledge chunks (`KNOWLEDGE_SOURCE_TYPES`) so a
   *  code-heavy corpus cannot crowd the KB out of the page entirely. A QUOTA, not
   *  a boost: MEASURED on a 9156-code / 41-KB repo, the KB chunk that answered the
   *  query sat at dense rank 41 behind 40 code chunks, and 11 of 18 logged queries
   *  returned no KB at all. An RRF multiplier cannot close a rank-41 gap reliably
   *  without over-promoting the queries where KB already surfaces. Floor, not
   *  ceiling — a page that already holds this many knowledge hits is untouched.
   *  0 disables the reserve and restores the previous ranking exactly. */
  knowledgeReserve: number;
  /** A reserved slot is filled only when the candidate's dense similarity is at
   *  least this fraction of the best CODE hit's. MEASURED across 18 real queries,
   *  best-KB/best-code ranged 0.630-1.043, and the two below 0.75 were the pure
   *  symbol lookups (`CProduct class d_product.inc ...`, `PDF certificate
   *  generation mPDF pdf_generation.class.inc`) where the KB genuinely has less to
   *  say. So the reserve stands down on exactly those, and needs no absolute
   *  threshold that would have to be re-tuned per corpus. */
  knowledgeReserveRatio: number;
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
  lexicalOnly: false,
  knowledgeReserve: 2,
  knowledgeReserveRatio: 0.75,
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

/** Options `applyKnowledgeReserve` reads. A subset of `RagSearchConfig` so the
 *  api can re-apply the reserve when it trims the local page, without holding a
 *  whole search config. */
export interface KnowledgeReserveOptions {
  topK: number;
  knowledgeReserve: number;
  knowledgeReserveRatio: number;
}

const KNOWLEDGE_TYPE_SET: ReadonlySet<string> = new Set(KNOWLEDGE_SOURCE_TYPES);

export function isKnowledgeHit(hit: RagSearchHit): boolean {
  return KNOWLEDGE_TYPE_SET.has(hit.sourceType);
}

/** Hold up to `knowledgeReserve` of a page's slots for knowledge chunks, so a
 *  corpus with two orders of magnitude more code than KB cannot fill every slot
 *  with code. Pure, and the ONLY place the quota is expressed — used both when a
 *  search builds its page and when `mergeHits` trims that page to make room for
 *  the global KB, since a reserve that survives only the first is not a reserve.
 *
 *  Ranking is untouched: promoted hits keep the `rrf` they earned (usually low,
 *  which is why they were being cut) and are appended AFTER the rrf-ranked rows
 *  rather than being given a fabricated score. `rrf` is shown to agents and
 *  logged, so it must keep meaning what it says.
 *
 *  Three ways the reserve stands down, all deliberate:
 *  - no code hits, so there is nothing crowding anything out and no denominator
 *    for the ratio (this is the global-KB store, where every row is `kb`);
 *  - the best knowledge candidate is too far below the best code hit
 *    (`knowledgeReserveRatio`) — the query was a symbol lookup the KB cannot
 *    answer;
 *  - the page already holds that many knowledge hits.
 *  Slots the reserve does not fill go back to code, mirroring the global reserve
 *  in `mergeHits`. */
export function applyKnowledgeReserve(
  hits: RagSearchHit[],
  opts: KnowledgeReserveOptions,
): RagSearchHit[] {
  const { topK, knowledgeReserve, knowledgeReserveRatio } = opts;
  if (topK <= 0) return [];
  const byRrf = [...hits].sort((a, b) => b.rrf - a.rrf);
  if (knowledgeReserve <= 0) return byRrf.slice(0, topK);

  // A small page must not be handed over to the reserve: topK reaches this route
  // as low as 4, where a flat 2 would be half of it.
  const reserve = Math.min(knowledgeReserve, Math.floor(topK / 3));
  if (reserve <= 0) return byRrf.slice(0, topK);

  // Only rows the page would otherwise CUT are promoted. A page that already ranks
  // its knowledge hits keeps them exactly where the fusion put them — the reserve
  // is a floor on presence, never a re-ordering.
  const base = byRrf.slice(0, topK);
  const codeSims = base.filter((h) => !isKnowledgeHit(h)).map((h) => h.denseSim);
  if (codeSims.length === 0) return base;
  const slots = reserve - base.filter(isKnowledgeHit).length;
  if (slots <= 0) return base;

  const held = new Set(base.map(hitKey));
  const floor = Math.max(...codeSims) * knowledgeReserveRatio;
  const promoted = byRrf
    .filter((h) => isKnowledgeHit(h) && !held.has(hitKey(h)) && h.denseSim >= floor)
    .sort((a, b) => b.denseSim - a.denseSim)
    .slice(0, slots);
  if (promoted.length === 0) return base;

  // Make room by dropping the weakest CODE rows, never a knowledge hit the page
  // already earned on rank.
  let toDrop = promoted.length;
  const kept: RagSearchHit[] = [];
  for (let i = base.length - 1; i >= 0; i -= 1) {
    const hit = base[i]!;
    if (toDrop > 0 && !isKnowledgeHit(hit)) {
      toDrop -= 1;
      continue;
    }
    kept.unshift(hit);
  }
  return [...kept, ...promoted];
}

function hitKey(hit: RagSearchHit): string {
  return `${hit.sourcePath} ${hit.sectionId} ${hit.chunkIndex}`;
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

/** The dimensions the facet filter constrains. Exported so a consumer that
 *  filters the same facet shape outside SQL (the global KB prompt digest) cannot
 *  drift from what retrieval actually scopes on. */
export const FACET_FILTER_DIMENSIONS = [
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
  const usePgvector = (await hasVectorColumn(conn)) && !cfg.lexicalOnly;
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
    // No usable dense half — either a jsonb-fallback store with no vector column,
    // or `lexicalOnly` for a repo whose vectors cannot be trusted. Lexical ranking.
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

  const hits = rows.map(toHit);

  // The reserve needs a dense similarity to rank and gate on, and every row on the
  // lexical-only branch reports 0 — a jsonb store with no vector column, a repo whose
  // owner accepted `rag_embed_lexical_only` after embeddings failed, or a single query
  // that could not be embedded. Nothing to reserve from, so leave the page alone.
  if (!usePgvector || cfg.knowledgeReserve <= 0) return hits;
  // Skipped outright when the page holds no code, which is the global KB store (every
  // row there is `kb`): no crowding to correct, and no second query to pay for.
  if (!hits.some((h) => !isKnowledgeHit(h))) return hits;

  const candidates = await fetchKnowledgeCandidates(conn, {
    qv: vectorLiteral(queryVec),
    dims,
    limit: cfg.knowledgeReserve,
    denseFloor: cfg.denseFloor,
    filter,
    repositoryId,
  });
  return applyKnowledgeReserve([...hits, ...candidates.map(toHit)], cfg);
}

function toHit(r: RawRow): RagSearchHit {
  return {
    sourcePath: r.source_path,
    sectionId: r.section_id,
    chunkIndex: typeof r.chunk_index === 'number' ? r.chunk_index : Number(r.chunk_index),
    sourceType: r.source_type,
    content: r.content,
    denseSim: num(r.dense_sim),
    tsNorm: num(r.ts_norm),
    hybrid: num(r.hybrid),
    rrf: num(r.rrf),
  };
}

/** The best knowledge chunks for a query, ranked by dense similarity alone —
 *  candidates for `applyKnowledgeReserve`, not results.
 *
 *  A SECOND query rather than another CTE unioned into the main one, because a row
 *  reached only through such a union carries no `d_rank` and no `l_rank`, so it scores
 *  `rrf = 0` and the main statement's own `ORDER BY rrf DESC LIMIT` discards it before
 *  any caller sees it — the reserve would have had nothing to draw on. Keeping it
 *  separate also leaves the ranking SQL byte-for-byte unchanged.
 *
 *  `source_type = ANY(...)` on the knowledge types is served by `idx_rag_source_type`:
 *  MEASURED on a 9197-row index, 1.6 ms against 8.6 ms for a `<> 'code'` sequential
 *  scan. `denseFloor` (never `codeDenseFloor`) applies, so a promoted row has still
 *  cleared the same relevance gate the main query would have held it to. */
async function fetchKnowledgeCandidates(
  conn: RagConnection,
  opts: {
    qv: string;
    dims: number;
    limit: number;
    denseFloor: number;
    filter?: RagFacetFilter;
    repositoryId?: string;
  },
): Promise<RawRow[]> {
  const { qv, dims, limit, denseFloor, filter, repositoryId } = opts;
  // Base params are $1..$4; facet params (if any) start at $5; repository_id last.
  const fc = filter ? buildFacetClause(filter, 5) : null;
  const repoParam = 5 + (fc?.params.length ?? 0);
  const conds = [
    `source_type = ANY($2::text[])`,
    ...(fc ? [fc.core] : []),
    ...(repositoryId ? [`repository_id = $${repoParam}`] : []),
  ];
  const params: (string | number)[] = [
    qv,
    pgTextArrayLiteral([...KNOWLEDGE_SOURCE_TYPES]),
    limit,
    denseFloor,
    ...(fc?.params ?? []),
    ...(repositoryId ? [repositoryId] : []),
  ];

  return (await conn.pg.unsafe(
    `
      WITH q AS (SELECT $1::vector AS qv, ($1::vector)::halfvec(${dims}) AS qvh)
      SELECT source_path, section_id, chunk_index, source_type, content,
             1 - (vector <=> (SELECT qv FROM q)) AS dense_sim,
             0 AS ts_norm, 0 AS hybrid, 0 AS rrf
      FROM ${RAG_TABLE}
      WHERE ${conds.join('\n        AND ')}
        AND (1 - (vector <=> (SELECT qv FROM q))) >= $4::double precision
      ORDER BY (vector::halfvec(${dims})) <=> (SELECT qvh FROM q)
      LIMIT $3
      `,
    params,
  )) as unknown as RawRow[];
}
