import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, loadPreviousStepOutput } from '../onboarding/_helpers.js';
import {
  resolveRagConnection,
  ensureRagSchema,
  RAG_TABLE,
  type RagMode,
  type RagToolingPrefs,
} from '../onboarding/_rag-connection.js';
import {
  extractMarkdownSections,
  extractCodeSections,
  chunkSection,
  CODE_EXTENSIONS,
  type RagChunk,
} from '../onboarding/_rag-chunkers.js';
import {
  probeOllama,
  ollamaEmbed,
  hashEmbed,
  vectorLiteral,
  EMBED_BATCH_SIZE,
} from '../onboarding/_rag-embed.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface RagSyncDetect {
  ragConfigured: boolean;
  ragMode: RagMode;
  ragToolingPrefs: RagToolingPrefs | null;
  projectName: string;
  kbFileCount: number;
  codeFileCount: number;
  ollamaReachable: boolean;
}

interface RagSyncApply {
  performed: boolean;
  reason: string;
  inserted: number;
  updated: number;
  skipped: number;
  deleted: number;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SOURCE_PREFIXES = ['.claude/knowledge_base/'];
const CODE_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.ddev',
  '.cache',
  'coverage',
  '.tox',
  '.venv',
  'venv',
]);

/* ------------------------------------------------------------------ */
/* File collection (shared with step 10)                               */
/* ------------------------------------------------------------------ */

async function collectKbFiles(repo: string): Promise<string[]> {
  const out: string[] = [];
  const candidates = await listFilesMatching(
    repo,
    (rel, isDir) => {
      if (isDir) return false;
      if (!rel.endsWith('.md')) return false;
      return SOURCE_PREFIXES.some((p) => rel.startsWith(p));
    },
    5,
  );
  out.push(...candidates);
  return out.sort();
}

async function collectCodeFiles(repo: string): Promise<string[]> {
  const codeExts = new Set(Object.keys(CODE_EXTENSIONS));
  const files = await listFilesMatching(
    repo,
    (rel, isDir) => {
      const parts = rel.split('/');
      if (parts.some((p) => CODE_IGNORE_DIRS.has(p))) return false;
      if (isDir) return false;
      return codeExts.has(path.extname(rel).toLowerCase());
    },
    8,
  );
  return files.sort();
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const preRagSyncStep: StepDefinition<RagSyncDetect, RagSyncApply> = {
  metadata: {
    id: '02-pre-rag-sync',
    workflowType: 'workflow',
    index: 2,
    title: 'Pre-workflow RAG sync',
    description:
      'Incrementally synchronises knowledge base and code files into the RAG vector store. Uses chunk hashing to skip unchanged content. Skipped if no RAG infrastructure is configured.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RagSyncDetect> {
    await ctx.emitProgress('Loading RAG configuration...');

    // Find the repository for this task
    const taskRow = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
    });
    const repositoryId = taskRow?.repositoryId ?? null;

    // Find the most recent completed onboarding task for the same repo
    let ragPrefs: RagToolingPrefs | null = null;
    let projectName = 'default';

    if (repositoryId) {
      const onboardingTask = await ctx.db.query.tasks.findFirst({
        where: and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.type, 'onboarding'),
        ),
        orderBy: [desc(schema.tasks.createdAt)],
      });

      if (onboardingTask) {
        const toolingPrev = await loadPreviousStepOutput(
          ctx.db,
          onboardingTask.id,
          '04-tooling-infrastructure',
        );
        if (toolingPrev?.output) {
          const o = toolingPrev.output as { tooling?: Record<string, unknown> };
          const t = o.tooling ?? {};
          ragPrefs = {
            ragMode: ((t.ragMode as string) ?? 'none') as RagMode,
            ragConnectionString: (t.ragConnectionString as string) || null,
            ollamaUrl: (t.ollamaUrl as string) || null,
            embeddingModel: (t.embeddingModel as string) || null,
            embeddingDimensions:
              typeof t.embeddingDimensions === 'number' ? t.embeddingDimensions : 2560,
          };
        }

        const envPrev = await loadPreviousStepOutput(ctx.db, onboardingTask.id, '01-env-detect');
        const envData = (envPrev?.detect as { data?: { project?: { name?: string } } } | null)
          ?.data;
        projectName = envData?.project?.name ?? 'default';
      }
    }

    const ragConfigured = ragPrefs !== null && ragPrefs.ragMode !== 'none';
    let kbFileCount = 0;
    let codeFileCount = 0;
    let ollamaReachable = false;

    if (ragConfigured && ragPrefs) {
      await ctx.emitProgress('Counting source files...');
      const kbFiles = await collectKbFiles(ctx.repoPath);
      const codeFiles = await collectCodeFiles(ctx.repoPath);
      kbFileCount = kbFiles.length;
      codeFileCount = codeFiles.length;

      if (ragPrefs.ollamaUrl) {
        await ctx.emitProgress('Testing Ollama connectivity...');
        ollamaReachable = await probeOllama(ragPrefs.ollamaUrl);
      }
    }

    return {
      ragConfigured,
      ragMode: ragPrefs?.ragMode ?? 'none',
      ragToolingPrefs: ragPrefs,
      projectName,
      kbFileCount,
      codeFileCount,
      ollamaReachable,
    };
  },

  form(_ctx, detected): FormSchema {
    if (!detected.ragConfigured) {
      return {
        title: 'Pre-workflow RAG sync',
        description: 'No RAG configuration found from onboarding. RAG sync will be skipped.',
        fields: [{ type: 'checkbox', id: 'runSync', label: 'Run RAG sync', default: false }],
        submitLabel: 'Continue',
      };
    }

    return {
      title: 'Pre-workflow RAG sync',
      description: [
        `RAG mode: ${detected.ragMode}`,
        `KB files: ${detected.kbFileCount}`,
        `Code files: ${detected.codeFileCount}`,
        `Ollama: ${detected.ollamaReachable ? 'reachable' : 'unavailable (hash fallback)'}`,
        'Unchanged chunks will be skipped via content hashing.',
      ].join('\n'),
      fields: [
        {
          type: 'checkbox',
          id: 'runSync',
          label: 'Run incremental RAG sync before starting the workflow',
          default: true,
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx, args): Promise<RagSyncApply> {
    const detected = args.detected as RagSyncDetect;
    const values = args.formValues as { runSync?: boolean };

    if (!values.runSync || !detected.ragConfigured || !detected.ragToolingPrefs) {
      ctx.logger.info('rag sync disabled or not configured');
      return {
        performed: false,
        reason: 'disabled by user or not configured',
        inserted: 0,
        updated: 0,
        skipped: 0,
        deleted: 0,
      };
    }

    const prefs = detected.ragToolingPrefs;
    await ctx.emitProgress('Connecting to RAG database...');
    const conn = await resolveRagConnection(prefs, ctx.db, detected.projectName);
    if (!conn) {
      return {
        performed: false,
        reason: 'connection resolved to null',
        inserted: 0,
        updated: 0,
        skipped: 0,
        deleted: 0,
      };
    }

    try {
      await ctx.emitProgress('Ensuring RAG schema...');
      const { usedPgvector } = await ensureRagSchema(conn);
      const useOllama = detected.ollamaReachable && !!prefs.ollamaUrl && !!prefs.embeddingModel;

      // Resolve repository_id
      let repositoryId: string | null = null;
      try {
        const rows = (await ctx.db.execute({
          sql: `SELECT repository_id FROM tasks WHERE id = $1 LIMIT 1`,
          params: [ctx.taskId],
        } as never)) as unknown;
        if (Array.isArray(rows) && rows.length > 0) {
          repositoryId = (rows[0] as { repository_id?: string }).repository_id ?? null;
        }
      } catch {
        /* non-critical */
      }

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let deleted = 0;

      // Process KB and code files
      const kbFiles = await collectKbFiles(ctx.repoPath);
      const codeFiles = await collectCodeFiles(ctx.repoPath);

      const allFiles: Array<{ relPath: string; sourceType: 'kb' | 'code' }> = [
        ...kbFiles.map((r) => ({ relPath: r, sourceType: 'kb' as const })),
        ...codeFiles.map((r) => ({ relPath: r, sourceType: 'code' as const })),
      ];

      // Track all source_paths we process (for stale cleanup)
      const processedPaths = new Set<string>();

      for (let fi = 0; fi < allFiles.length; fi += 1) {
        const { relPath, sourceType } = allFiles[fi]!;
        processedPaths.add(relPath);
        await ctx.emitProgress(`Syncing (${fi + 1}/${allFiles.length}): ${relPath}`);

        let text: string;
        try {
          text = await readFile(path.join(ctx.repoPath, relPath), 'utf8');
        } catch {
          continue;
        }

        const sections =
          sourceType === 'kb'
            ? extractMarkdownSections(text, relPath)
            : extractCodeSections(text, relPath);
        const chunks: RagChunk[] = [];
        for (const section of sections) {
          chunks.push(...chunkSection(section));
        }

        // Get existing chunks for this file
        const existingRows = (await conn.pg.unsafe(
          `SELECT section_id, chunk_index, chunk_hash FROM ${RAG_TABLE}
           WHERE task_id = $1 AND source_path = $2`,
          [ctx.taskId, relPath],
        )) as Array<{ section_id: string; chunk_index: number; chunk_hash: string | null }>;

        const existingMap = new Map<string, string | null>();
        for (const row of existingRows) {
          existingMap.set(`${row.section_id}:${row.chunk_index}`, row.chunk_hash);
        }

        // Track which existing entries we've seen
        const seenKeys = new Set<string>();

        // Collect chunks that need embedding
        const toEmbed: Array<{ chunk: RagChunk; action: 'insert' | 'update' }> = [];

        for (const chunk of chunks) {
          const key = `${chunk.sectionId}:${chunk.chunkIndex}`;
          seenKeys.add(key);
          const existingHash = existingMap.get(key);

          if (existingHash === chunk.chunkHash) {
            skipped += 1;
            continue;
          }

          if (existingHash !== undefined) {
            // Hash changed — delete old, will insert new
            await conn.pg.unsafe(
              `DELETE FROM ${RAG_TABLE} WHERE task_id = $1 AND source_path = $2 AND section_id = $3 AND chunk_index = $4`,
              [ctx.taskId, relPath, chunk.sectionId, chunk.chunkIndex],
            );
            toEmbed.push({ chunk, action: 'update' });
          } else {
            toEmbed.push({ chunk, action: 'insert' });
          }
        }

        // Delete stale entries (sections/chunks no longer in current extraction)
        for (const key of existingMap.keys()) {
          if (!seenKeys.has(key)) {
            const colonPos = key.indexOf(':');
            const sectionId = key.slice(0, colonPos);
            const chunkIdx = parseInt(key.slice(colonPos + 1), 10);
            await conn.pg.unsafe(
              `DELETE FROM ${RAG_TABLE} WHERE task_id = $1 AND source_path = $2 AND section_id = $3 AND chunk_index = $4`,
              [ctx.taskId, relPath, sectionId, chunkIdx],
            );
            deleted += 1;
          }
        }

        // Embed and insert new/updated chunks in batches
        for (let batchStart = 0; batchStart < toEmbed.length; batchStart += EMBED_BATCH_SIZE) {
          const batch = toEmbed.slice(batchStart, batchStart + EMBED_BATCH_SIZE);
          const texts = batch.map((e) => e.chunk.content);
          let embeddings: number[][];

          if (useOllama) {
            try {
              embeddings = await ollamaEmbed(prefs.ollamaUrl!, prefs.embeddingModel!, texts);
            } catch (err) {
              ctx.logger.warn({ err, relPath, batchStart }, 'Ollama failed; hash fallback');
              embeddings = texts.map((t) => hashEmbed(t, prefs.embeddingDimensions));
            }
          } else {
            embeddings = texts.map((t) => hashEmbed(t, prefs.embeddingDimensions));
          }

          for (let i = 0; i < batch.length; i += 1) {
            const { chunk, action } = batch[i]!;
            if (usedPgvector) {
              const literal = vectorLiteral(embeddings[i]!);
              await conn.pg.unsafe(
                `INSERT INTO ${RAG_TABLE} (task_id, repository_id, source_type, source_path, section_id, chunk_index, chunk_hash, content, vector)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
                [
                  ctx.taskId,
                  repositoryId,
                  sourceType,
                  relPath,
                  chunk.sectionId,
                  chunk.chunkIndex,
                  chunk.chunkHash,
                  chunk.content,
                  literal,
                ],
              );
            } else {
              const json = JSON.stringify(embeddings[i]!);
              await conn.pg.unsafe(
                `INSERT INTO ${RAG_TABLE} (task_id, repository_id, source_type, source_path, section_id, chunk_index, chunk_hash, content, embedding_json)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
                [
                  ctx.taskId,
                  repositoryId,
                  sourceType,
                  relPath,
                  chunk.sectionId,
                  chunk.chunkIndex,
                  chunk.chunkHash,
                  chunk.content,
                  json,
                ],
              );
            }
            if (action === 'update') updated += 1;
            else inserted += 1;
          }
        }
      }

      // Delete entries for files that no longer exist
      const orphanRows = (await conn.pg.unsafe(
        `SELECT DISTINCT source_path FROM ${RAG_TABLE} WHERE task_id = $1`,
        [ctx.taskId],
      )) as Array<{ source_path: string }>;
      for (const row of orphanRows) {
        if (!processedPaths.has(row.source_path)) {
          const result = await conn.pg.unsafe(
            `DELETE FROM ${RAG_TABLE} WHERE task_id = $1 AND source_path = $2`,
            [ctx.taskId, row.source_path],
          );
          deleted += result.count;
        }
      }

      await ctx.emitProgress(
        `RAG sync complete: ${inserted} inserted, ${updated} updated, ${skipped} unchanged, ${deleted} deleted.`,
      );

      ctx.logger.info({ inserted, updated, skipped, deleted }, 'rag sync complete');
      return { performed: true, reason: 'sync completed', inserted, updated, skipped, deleted };
    } finally {
      await conn.close();
    }
  },
};
