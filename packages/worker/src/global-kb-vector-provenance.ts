import type { Database } from '@haive/database';
import { configService, logger } from '@haive/shared';
import { resolveGlobalKbEnabled, withGlobalKb } from '@haive/shared/global-kb';
import { cosineSimilarity, hashEmbed } from '@haive/shared/rag';

const log = logger.child({ module: 'global-kb-vector-provenance' });

const BATCH_SIZE = 200;
// A float4 round trip through pgvector leaves a hash vector within 1e-6 of its recomputation.
const HASH_MATCH_COSINE = 0.9999;

function vectorOf(value: unknown): number[] | null {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) && parsed.length > 0 ? (parsed as number[]) : null;
}

/** Classify the global KB vectors written before `embed_kind` existed.
 *
 *  A hash vector is a pure function of its chunk text, so recomputing `hashEmbed(content, dims)`
 *  and comparing it with the stored vector tells the two kinds apart exactly, with no re-embed:
 *  a match is `hashed`, anything else is `model` (its `embed_model` stays NULL, as it is unknown).
 *
 *  Convergent: it selects only rows still NULL and writes only rows still NULL, so a second run
 *  and a concurrent sync change nothing; it never deletes. A row whose vector cannot be read stays
 *  NULL (excluded from dense ranking, still found by words). Best-effort: a disabled, unconfigured
 *  or unreachable store is logged and left for the next boot. */
export async function classifyGlobalKbVectorProvenance(db: Database): Promise<void> {
  try {
    if (!(await resolveGlobalKbEnabled(configService))) return;
    await withGlobalKb(db, async ({ conn }) => {
      const usedPgvector =
        (
          (await conn.pg.unsafe(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_rag_embeddings' AND column_name = 'vector'`,
          )) as unknown as unknown[]
        ).length > 0;
      const column = usedPgvector ? 'vector::text' : 'embedding_json';
      let after = 0;
      let hashed = 0;
      let model = 0;
      for (;;) {
        const rows = (await conn.pg.unsafe(
          `SELECT id, content, ${column} AS v FROM ai_rag_embeddings WHERE embed_kind IS NULL AND id > $1 ORDER BY id LIMIT $2`,
          [after, BATCH_SIZE],
        )) as unknown as Array<{ id: number; content: string; v: unknown }>;
        if (rows.length === 0) break;
        after = rows[rows.length - 1]!.id;
        const ids: Record<'hashed' | 'model', number[]> = { hashed: [], model: [] };
        for (const row of rows) {
          const stored = vectorOf(row.v);
          if (stored === null) continue;
          const match = cosineSimilarity(stored, hashEmbed(row.content, stored.length));
          ids[match >= HASH_MATCH_COSINE ? 'hashed' : 'model'].push(row.id);
        }
        for (const kind of ['hashed', 'model'] as const) {
          if (ids[kind].length === 0) continue;
          await conn.pg.unsafe(
            `UPDATE ai_rag_embeddings SET embed_kind = $1 WHERE embed_kind IS NULL AND id = ANY($2::int[])`,
            [kind, `{${ids[kind].join(',')}}`],
          );
        }
        hashed += ids.hashed.length;
        model += ids.model.length;
      }
      if (hashed + model > 0) {
        log.info({ hashed, model }, 'classified global KB vectors written before provenance');
      }
    });
  } catch (err) {
    log.warn({ err }, 'global KB vector provenance classification skipped');
  }
}
