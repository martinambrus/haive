import { ollamaEmbed, probeOllama, vectorLiteral } from '@haive/shared/rag';
import type { StepContext } from '../../step-definition.js';
import {
  RAG_TABLE,
  resolveRagConnection,
  type RagConnection,
  type RagToolingPrefs,
} from '../onboarding/_rag-connection.js';

// Kept a LEAF module (no import from _rag-index) so the write side (_rag-index imports
// indexTaskEmbedding) forms no cycle. The read side takes prefs + projectName from its caller
// (00b resolves them via resolveRagSyncPrefs) rather than importing that resolver here.

// Stored task-embedding pipeline for the effort estimator (task-time estimation v2.2).
//
// Each completed workflow task's title+description is embedded once and stored as a
// source_type='task' row in the repo's RAG vector store (the same per-project/external
// ai_rag_embeddings the file RAG uses — reused so there is no new table, index, or DB, and
// so per-project stores keep their tenant isolation). At estimate time 00b-estimate embeds
// the NEW task's text and cosine-ranks those prior-task rows to pick the most SEMANTICALLY
// similar prior tasks as effort anchors, instead of just the newest. Both paths are
// best-effort: RAG unconfigured / ollama down / a jsonb-only store all fall back to the
// estimator's newest-first anchor selection.

/** source_type tag for a task-embedding row. NOT a file type, so runRagIndexSync's
 *  orphaned-file cleanup must exclude it (it deletes by source_path not in the file set). */
export const TASK_EMBED_SOURCE_TYPE = 'task';
const TASK_EMBED_SECTION = 'task';
/** Bound the embed input — a title plus a lead slice of the description is plenty of signal. */
const TASK_TEXT_CAP = 2000;

/** The text embedded for a task: its title plus a bounded lead of its description. Shared by
 *  the write (index) and read (retrieve) sides so the query matches how anchors were stored. */
export function taskEmbedText(title: string, description: string | null): string {
  return `${title}\n${(description ?? '').slice(0, TASK_TEXT_CAP)}`.trim();
}

/** Upsert one task's title+description embedding as a source_type='task' row. pgvector stores
 *  only — retrieval is vector-based, so a jsonb-fallback store's task rows would be unqueryable
 *  and are simply not written (the caller gates on usedPgvector). Idempotent on
 *  (repository_id, source_path=taskId, section_id, chunk_index=0). */
export async function indexTaskEmbedding(
  conn: RagConnection,
  prefs: RagToolingPrefs,
  repositoryId: string,
  taskId: string,
  title: string,
  description: string | null,
): Promise<void> {
  if (!prefs.ollamaUrl || !prefs.embeddingModel) return;
  const text = taskEmbedText(title, description);
  if (!text) return;
  const vectors = await ollamaEmbed(prefs.ollamaUrl, prefs.embeddingModel, [text]);
  const vec = vectors?.[0];
  if (!vec || vec.length === 0) return;
  await conn.pg.unsafe(
    `INSERT INTO ${RAG_TABLE} (task_id, repository_id, source_type, source_path, section_id, chunk_index, content, vector)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $7::vector)
     ON CONFLICT (repository_id, source_path, section_id, chunk_index) WHERE repository_id IS NOT NULL
     DO UPDATE SET task_id = EXCLUDED.task_id, source_type = EXCLUDED.source_type, content = EXCLUDED.content, vector = EXCLUDED.vector`,
    [
      taskId,
      repositoryId,
      TASK_EMBED_SOURCE_TYPE,
      taskId,
      TASK_EMBED_SECTION,
      text,
      vectorLiteral(vec),
    ],
  );
}

/** Best-effort semantic retrieval: embed the new task's text, cosine-rank the repo's stored
 *  source_type='task' rows, and return up to `limit` most-similar PRIOR task ids (most-similar
 *  first, current task excluded). Returns [] when ollama is unreachable, the store is jsonb-only
 *  (the vector cast throws → caught), or anything else fails — the estimator then keeps its
 *  deterministic newest-first anchor selection. Prefs + projectName come from the caller (which
 *  already resolved them) so this stays a leaf module. The dims are a trusted number from prefs,
 *  interpolated into the halfvec cast the HNSW index is built on (matching the file RAG's dense
 *  query); the query vector is a bound parameter. */
export async function retrieveSimilarTaskIds(
  ctx: StepContext,
  prefs: RagToolingPrefs,
  projectName: string,
  repositoryId: string,
  queryText: string,
  limit: number,
): Promise<string[]> {
  if (!queryText || limit <= 0) return [];
  if (!prefs.ollamaUrl || !prefs.embeddingModel) return [];
  let conn: RagConnection | null = null;
  try {
    if (!(await probeOllama(prefs.ollamaUrl))) return [];
    const vectors = await ollamaEmbed(prefs.ollamaUrl, prefs.embeddingModel, [queryText]);
    const qvec = vectors?.[0];
    if (!qvec || qvec.length === 0) return [];

    conn = await resolveRagConnection(prefs, ctx.db, projectName);
    if (!conn) return [];
    const dims = conn.embeddingDimensions;
    const rows = (await conn.pg.unsafe(
      `SELECT task_id
       FROM ${RAG_TABLE}
       WHERE source_type = $1 AND repository_id = $2 AND task_id IS NOT NULL AND task_id <> $3
       ORDER BY (vector::halfvec(${dims})) <=> ($4::vector)::halfvec(${dims})
       LIMIT $5`,
      [TASK_EMBED_SOURCE_TYPE, repositoryId, ctx.taskId, vectorLiteral(qvec), limit],
    )) as Array<{ task_id: string | null }>;
    return rows.map((r) => r.task_id).filter((id): id is string => !!id);
  } catch (err) {
    ctx.logger.warn({ err }, 'semantic task retrieval failed (falling back to newest-first)');
    return [];
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}
