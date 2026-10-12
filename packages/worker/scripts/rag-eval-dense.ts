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
  const indexIds = await ids(['enable_seqscan = off', 'enable_bitmapscan = off']);
  const exactIds = await ids(['enable_indexscan = off']);
  const plan = (await run([], true)) as Record<string, string>[];
  const exact = new Set(exactIds);
  return {
    indexRows: indexIds.length,
    exactRows: exactIds.length,
    overlap: exact.size === 0 ? 0 : indexIds.filter((id) => exact.has(id)).length / exact.size,
    defaultUsesHnsw: plan.some((r) => Object.values(r).some((v) => v.includes(HNSW_INDEX))),
  };
}
