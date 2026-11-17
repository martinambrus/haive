import { RAG_TABLE, TASK_SOURCE_TYPE, type RagConnection } from '@haive/shared/rag';

export interface DensePoolCheck {
  indexRows: number;
  exactRows: number;
  overlap: number;
  defaultUsesHnsw: boolean;
}

const HNSW_INDEX = 'idx_rag_vector_hnsw';

/**
 * Eval-only copy of the dense candidate query in search.ts, run with the index forced and with it
 * excluded, in read-only transactions so a SET LOCAL never outlives its query.
 */
export async function checkDensePool(
  pg: RagConnection['pg'],
  vectorLiteral: string,
  dims: number,
  limit: number,
  repositoryId?: string,
): Promise<DensePoolCheck> {
  const where = `WHERE source_type <> '${TASK_SOURCE_TYPE}'${repositoryId ? ' AND repository_id = $3' : ''}`;
  const sql = `SELECT id FROM ${RAG_TABLE} ${where}
    ORDER BY (vector::halfvec(${dims})) <=> ($1::vector)::halfvec(${dims}) LIMIT $2`;
  const params = repositoryId ? [vectorLiteral, limit, repositoryId] : [vectorLiteral, limit];
  const run = async (settings: string[], explain: boolean): Promise<unknown[]> =>
    pg.begin('read only', async (tx) => {
      for (const s of settings) await tx.unsafe(`SET LOCAL ${s}`);
      return tx.unsafe(explain ? `EXPLAIN ${sql}` : sql, params as never[]);
    });
  const ids = async (settings: string[]) =>
    ((await run(settings, false)) as { id: number }[]).map((r) => r.id);
  // Match the shipped per-repository denseRead policy; the old check measured
  // PostgreSQL's default ef_search=40, not the search whose recall we report.
  const production = repositoryId
    ? ['hnsw.ef_search = 200', 'cpu_operator_cost = 0.1', "hnsw.iterative_scan = 'relaxed_order'"]
    : [];
  // Disabling sequential scans alone still permits the repository btree + sort
  // on a small corpus. Disable the sort too and VERIFY the plan: otherwise an
  // exact-vs-exact comparison can silently advertise perfect HNSW recall.
  const indexSettings = [
    ...production,
    'enable_seqscan = off',
    'enable_bitmapscan = off',
    'enable_sort = off',
  ];
  const indexPlan = (await run(indexSettings, true)) as Record<string, string>[];
  if (!indexPlan.some((r) => Object.values(r).some((v) => v.includes(HNSW_INDEX)))) {
    throw new Error(
      'dense check could not force idx_rag_vector_hnsw; refusing an exact-vs-exact comparison',
    );
  }
  const indexIds = await ids(indexSettings);
  const exactIds = await ids([
    'enable_indexscan = off',
    'enable_indexonlyscan = off',
    'enable_bitmapscan = off',
  ]);
  const plan = (await run(production, true)) as Record<string, string>[];
  const exact = new Set(exactIds);
  return {
    indexRows: indexIds.length,
    exactRows: exactIds.length,
    overlap: exact.size === 0 ? 0 : indexIds.filter((id) => exact.has(id)).length / exact.size,
    defaultUsesHnsw: plan.some((r) => Object.values(r).some((v) => v.includes(HNSW_INDEX))),
  };
}
