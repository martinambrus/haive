import { createHash } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  GLOBAL_KB_JOB_NAMES,
  QUEUE_NAMES,
  logger,
  type GlobalKbSyncJobPayload,
} from '@haive/shared';
import { hashEmbed, ollamaEmbed, vectorLiteral } from '@haive/shared/rag';
import { globalKbEntries, withGlobalKb, type GlobalKbContext } from '@haive/shared/global-kb';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import {
  chunkSection,
  extractMarkdownSections,
  slugifyHeading,
} from '../step-engine/steps/onboarding/_rag-chunkers.js';

const log = logger.child({ module: 'global-kb-sync' });

function entryContentHash(body: string, facets: unknown): string {
  return createHash('sha256')
    .update(body)
    .update(JSON.stringify(facets ?? {}))
    .digest('hex');
}

async function deleteChunks(
  ctx: GlobalKbContext,
  namespace: string,
  entryId: string,
): Promise<void> {
  await ctx.conn.pg.unsafe(`DELETE FROM ai_rag_embeddings WHERE namespace = $1 AND entry_id = $2`, [
    namespace,
    entryId,
  ]);
}

async function hasVectorColumn(ctx: GlobalKbContext): Promise<boolean> {
  const rows = (await ctx.conn.pg.unsafe(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_rag_embeddings' AND column_name = 'vector'`,
  )) as unknown as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/** Reconcile the global vector store to an entry's current state. Active entries
 *  are (re)chunked + (re)embedded with the GLOBAL embed model (hash fallback) and
 *  their chunks fully replaced; everything else has its chunks removed. */
export async function syncGlobalKbEntry(payload: GlobalKbSyncJobPayload): Promise<void> {
  await withGlobalKb(getDb(), async (ctx) => {
    const { entryId, namespace } = payload;

    if (payload.reason === 'delete') {
      await deleteChunks(ctx, namespace, entryId);
      return;
    }

    const entry = await ctx.db.query.globalKbEntries.findFirst({
      where: eq(globalKbEntries.id, entryId),
    });

    // Only `active` entries are retrievable; anything else holds no vectors.
    if (!entry || entry.status !== 'active') {
      await deleteChunks(ctx, namespace, entryId);
      return;
    }

    try {
      const sourcePath = `global_kb/${slugifyHeading(entry.title)}-${entry.id.slice(0, 8)}.md`;
      const sections = extractMarkdownSections(entry.body, sourcePath);
      const chunks = sections.flatMap((s) => chunkSection(s));

      if (chunks.length > 0) {
        const texts = chunks.map((c) => c.content);
        const useOllama = !!(ctx.conn.ollamaUrl && ctx.conn.embedModel);
        let embeddings: number[][];
        if (useOllama) {
          try {
            embeddings = await ollamaEmbed(ctx.conn.ollamaUrl!, ctx.conn.embedModel!, texts);
          } catch (err) {
            log.warn({ err, entryId }, 'Ollama embed failed; hash fallback');
            embeddings = texts.map((t) => hashEmbed(t, ctx.conn.embeddingDimensions));
          }
        } else {
          embeddings = texts.map((t) => hashEmbed(t, ctx.conn.embeddingDimensions));
        }

        const usedPgvector = await hasVectorColumn(ctx);
        const facetsJson = JSON.stringify(entry.facets ?? {});

        // Small per-entry corpus: replace all chunks atomically (delete +
        // insert) rather than upsert + stale-key bookkeeping.
        await ctx.conn.pg.begin(async (tx) => {
          await tx.unsafe(`DELETE FROM ai_rag_embeddings WHERE namespace = $1 AND entry_id = $2`, [
            entry.namespace,
            entry.id,
          ]);
          for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i]!;
            const common = [
              entry.namespace,
              entry.userId,
              entry.id,
              sourcePath,
              chunk.sectionId,
              chunk.chunkIndex,
              chunk.chunkHash,
              facetsJson,
              chunk.content,
            ];
            if (usedPgvector) {
              await tx.unsafe(
                `INSERT INTO ai_rag_embeddings (namespace, user_id, entry_id, source_type, source_path, section_id, chunk_index, chunk_hash, facets, content, vector)
                 VALUES ($1, $2, $3, 'kb', $4, $5, $6, $7, $8::jsonb, $9, $10::vector)`,
                [...common, vectorLiteral(embeddings[i]!)],
              );
            } else {
              await tx.unsafe(
                `INSERT INTO ai_rag_embeddings (namespace, user_id, entry_id, source_type, source_path, section_id, chunk_index, chunk_hash, facets, content, embedding_json)
                 VALUES ($1, $2, $3, 'kb', $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb)`,
                [...common, JSON.stringify(embeddings[i]!)],
              );
            }
          }
        });
      } else {
        // No extractable content (e.g. empty body): clear any stale chunks.
        await deleteChunks(ctx, entry.namespace, entry.id);
      }

      await ctx.db
        .update(globalKbEntries)
        .set({
          embedStatus: 'embedded',
          contentHash: entryContentHash(entry.body, entry.facets),
          updatedAt: new Date(),
        })
        .where(eq(globalKbEntries.id, entry.id));

      log.info({ entryId: entry.id, chunks: chunks.length }, 'global KB entry synced');
    } catch (err) {
      await ctx.db
        .update(globalKbEntries)
        .set({ embedStatus: 'failed' })
        .where(eq(globalKbEntries.id, entry.id))
        .catch(() => {});
      throw err;
    }
  });
}

export function startGlobalKbSyncWorker(): Worker {
  const worker = new Worker<GlobalKbSyncJobPayload>(
    QUEUE_NAMES.GLOBAL_KB_SYNC,
    async (job: Job<GlobalKbSyncJobPayload>) => {
      switch (job.name) {
        case GLOBAL_KB_JOB_NAMES.SYNC_ENTRY:
          await syncGlobalKbEntry(job.data);
          return;
        default:
          throw new Error(`Unknown global-kb job: ${job.name}`);
      }
    },
    { connection: getBullRedis(), concurrency: 2 },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'global KB sync job completed');
  });
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, name: job?.name, err }, 'global KB sync job failed');
  });

  return worker;
}
