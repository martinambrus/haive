import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, loadPreviousStepOutput } from './_helpers.js';
import {
  resolveRagConnection,
  ensureRagSchema,
  RAG_TABLE,
  type RagConnection,
  type RagMode,
  type RagToolingPrefs,
} from './_rag-connection.js';
import {
  extractMarkdownSections,
  extractCodeSections,
  chunkSection,
  CODE_EXTENSIONS,
  type RagChunk,
} from './_rag-chunkers.js';
import {
  probeOllama,
  ollamaEmbed,
  hashEmbed,
  vectorLiteral,
  EMBED_BATCH_SIZE,
} from './_rag-embed.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface RagSourceFile {
  relPath: string;
  sizeBytes: number;
}

export interface RagPopulateDetect {
  kbFiles: RagSourceFile[];
  codeFiles: RagSourceFile[];
  ollamaReachable: boolean;
  ollamaUrl: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number;
  ragMode: RagMode;
  ragConnectionString: string | null;
  projectName: string;
}

export interface RagPopulateApply {
  kbChunkCount: number;
  codeChunkCount: number;
  kbFileCount: number;
  codeFileCount: number;
  embeddingDimensions: number;
  tableName: string;
  usedPgvector: boolean;
  ragMode: RagMode;
  usedOllama: boolean;
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
/* File collection                                                     */
/* ------------------------------------------------------------------ */

async function collectKbFiles(repo: string): Promise<RagSourceFile[]> {
  const out: RagSourceFile[] = [];

  const candidates = await listFilesMatching(
    repo,
    (rel, isDir) => {
      if (isDir) return false;
      if (!rel.endsWith('.md')) return false;
      return SOURCE_PREFIXES.some((p) => rel.startsWith(p));
    },
    5,
  );

  for (const rel of candidates) {
    try {
      const text = await readFile(path.join(repo, rel), 'utf8');
      out.push({ relPath: rel, sizeBytes: Buffer.byteLength(text, 'utf8') });
    } catch {
      continue;
    }
  }

  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function collectCodeFiles(
  repo: string,
  excludePaths: readonly string[],
  selectedDirs?: readonly string[],
  extensionSet?: ReadonlySet<string>,
): Promise<RagSourceFile[]> {
  const codeExts = extensionSet ?? new Set(Object.keys(CODE_EXTENSIONS));
  const excludeSet = new Set(excludePaths.map((p) => p.replace(/\/$/, '')));
  const dirFilter = selectedDirs && selectedDirs.length > 0 ? new Set(selectedDirs) : null;

  const files = await listFilesMatching(
    repo,
    (rel, isDir) => {
      const parts = rel.split('/');
      // Skip ignored directories
      if (parts.some((p) => CODE_IGNORE_DIRS.has(p))) return false;
      // Skip user-excluded paths
      for (const ex of excludeSet) {
        if (rel.startsWith(ex + '/') || rel === ex) return false;
      }
      if (isDir) return false;
      // Filter to selected directories when available
      if (dirFilter) {
        const topDir = parts.length === 1 ? '.' : parts[0]!;
        // Check against both top-level and nested dir selections (e.g. 'modules/custom')
        let inSelected = dirFilter.has(topDir);
        if (!inSelected && parts.length > 2) {
          inSelected = dirFilter.has(parts.slice(0, 2).join('/'));
        }
        if (!inSelected) return false;
      }
      const ext = path.extname(rel).toLowerCase();
      return codeExts.has(ext);
    },
    8,
  );

  const out: RagSourceFile[] = [];
  for (const rel of files) {
    try {
      const text = await readFile(path.join(repo, rel), 'utf8');
      out.push({ relPath: rel, sizeBytes: Buffer.byteLength(text, 'utf8') });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

/* ------------------------------------------------------------------ */
/* Load tooling prefs from step 04                                     */
/* ------------------------------------------------------------------ */

interface ToolingOutput {
  tooling: {
    ragMode?: string;
    ragConnectionString?: string;
    ollamaUrl?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
  };
}

function loadToolingPrefs(output: unknown): RagToolingPrefs {
  const o = output as ToolingOutput | null;
  const t = o?.tooling ?? {};
  return {
    ragMode: (t.ragMode ?? 'none') as RagMode,
    ragConnectionString: t.ragConnectionString || null,
    ollamaUrl: t.ollamaUrl || null,
    embeddingModel: t.embeddingModel || null,
    embeddingDimensions: typeof t.embeddingDimensions === 'number' ? t.embeddingDimensions : 2560,
  };
}

/* ------------------------------------------------------------------ */
/* INSERT helper                                                       */
/* ------------------------------------------------------------------ */

async function insertChunk(
  conn: RagConnection,
  usedPgvector: boolean,
  taskId: string,
  repositoryId: string | null,
  sourceType: 'kb' | 'code',
  sourcePath: string,
  sectionId: string,
  chunkIndex: number,
  chunkHash: string,
  content: string,
  embedding: number[],
): Promise<void> {
  if (usedPgvector) {
    const literal = vectorLiteral(embedding);
    await conn.pg.unsafe(
      `INSERT INTO ${RAG_TABLE} (task_id, repository_id, source_type, source_path, section_id, chunk_index, chunk_hash, content, vector)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
      [
        taskId,
        repositoryId,
        sourceType,
        sourcePath,
        sectionId,
        chunkIndex,
        chunkHash,
        content,
        literal,
      ],
    );
  } else {
    const json = JSON.stringify(embedding);
    await conn.pg.unsafe(
      `INSERT INTO ${RAG_TABLE} (task_id, repository_id, source_type, source_path, section_id, chunk_index, chunk_hash, content, embedding_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        taskId,
        repositoryId,
        sourceType,
        sourcePath,
        sectionId,
        chunkIndex,
        chunkHash,
        content,
        json,
      ],
    );
  }
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const ragPopulateStep: StepDefinition<RagPopulateDetect, RagPopulateApply> = {
  metadata: {
    id: '10-rag-populate',
    workflowType: 'onboarding',
    index: 14,
    title: 'Populate RAG index',
    description:
      'Chunks knowledge base and code files, computes embeddings via Ollama (or deterministic fallback), and writes them to the configured PostgreSQL RAG database.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RagPopulateDetect> {
    // Load tooling prefs from step 04
    await ctx.emitProgress('Loading tooling preferences...');
    const toolingPrev = await loadPreviousStepOutput(
      ctx.db,
      ctx.taskId,
      '04-tooling-infrastructure',
    );
    const prefs = loadToolingPrefs(toolingPrev?.output);

    // Load project name + exclude paths from step 01
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (
      envPrev?.detect as {
        data?: {
          project?: { name?: string };
          paths?: { customCodePaths?: { exclude?: string[] } };
        };
      } | null
    )?.data;
    const projectName = envData?.project?.name ?? 'default';
    const excludePaths = envData?.paths?.customCodePaths?.exclude ?? [];

    // Load selected folders and extension set from step 09_7
    const ragSourcePrev = await loadPreviousStepOutput(
      ctx.db,
      ctx.taskId,
      '09_7-rag-source-selection',
    );
    const ragSourceOutput = ragSourcePrev?.output as {
      selectedDirs?: string[];
      extensionSet?: string[];
    } | null;
    const selectedDirs = ragSourceOutput?.selectedDirs;
    const resolvedExtSet = ragSourceOutput?.extensionSet
      ? new Set(ragSourceOutput.extensionSet)
      : undefined;

    // Collect KB files
    await ctx.emitProgress('Scanning for knowledge base files...');
    const kbFiles = await collectKbFiles(ctx.repoPath);

    // Collect code files (filtered to user-selected directories if available)
    await ctx.emitProgress('Scanning for code files...');
    const codeFiles = await collectCodeFiles(
      ctx.repoPath,
      excludePaths,
      selectedDirs,
      resolvedExtSet,
    );

    // Probe Ollama connectivity
    await ctx.emitProgress('Testing Ollama connectivity...');
    const ollamaReachable = prefs.ollamaUrl ? await probeOllama(prefs.ollamaUrl) : false;

    await ctx.emitProgress(
      `Found ${kbFiles.length} KB files, ${codeFiles.length} code files. Ollama: ${ollamaReachable ? 'reachable' : 'unavailable'}.`,
    );

    ctx.logger.info(
      {
        kbFileCount: kbFiles.length,
        codeFileCount: codeFiles.length,
        ragMode: prefs.ragMode,
        ollamaReachable,
        embeddingModel: prefs.embeddingModel,
        embeddingDimensions: prefs.embeddingDimensions,
      },
      'rag populate detect complete',
    );

    return {
      kbFiles,
      codeFiles,
      ollamaReachable,
      ollamaUrl: prefs.ollamaUrl,
      embeddingModel: prefs.embeddingModel,
      embeddingDimensions: prefs.embeddingDimensions,
      ragMode: prefs.ragMode,
      ragConnectionString: prefs.ragConnectionString,
      projectName,
    };
  },

  shouldRun() {
    return true;
  },

  form(_ctx, detected): FormSchema {
    if (detected.ragMode === 'none') {
      return {
        title: 'RAG population skipped',
        description:
          'RAG infrastructure was set to "none" in tooling preferences. Nothing to populate.',
        fields: [{ type: 'checkbox', id: 'confirmSkip', label: 'Confirm skip', default: true }],
        submitLabel: 'Continue',
      };
    }

    const statusParts: string[] = [
      `KB files: ${detected.kbFiles.length}`,
      `Code files: ${detected.codeFiles.length}`,
      `RAG mode: ${detected.ragMode}`,
      `Ollama: ${detected.ollamaReachable ? 'reachable' : 'UNREACHABLE'} at ${detected.ollamaUrl ?? '(not configured)'}`,
      `Model: ${detected.embeddingModel ?? '(not set)'}`,
      `Dimensions: ${detected.embeddingDimensions}`,
    ];
    if (!detected.ollamaReachable) {
      statusParts.push(
        'WARNING: Ollama not reachable. Will use deterministic hash embeddings as fallback.',
      );
    }

    return {
      title: 'Populate RAG index',
      description: statusParts.join('\n'),
      fields: [
        {
          type: 'checkbox',
          id: 'truncateExisting',
          label: 'Delete existing RAG rows for this task before inserting new ones',
          default: true,
        },
      ],
      submitLabel: 'Populate index',
    };
  },

  async apply(ctx, args): Promise<RagPopulateApply> {
    const detected = args.detected as RagPopulateDetect;

    if (detected.ragMode === 'none') {
      ctx.logger.info('rag populate skipped (mode=none)');
      return {
        kbChunkCount: 0,
        codeChunkCount: 0,
        kbFileCount: 0,
        codeFileCount: 0,
        embeddingDimensions: detected.embeddingDimensions,
        tableName: RAG_TABLE,
        usedPgvector: false,
        ragMode: 'none',
        usedOllama: false,
      };
    }

    const prefs: RagToolingPrefs = {
      ragMode: detected.ragMode,
      ragConnectionString: detected.ragConnectionString,
      ollamaUrl: detected.ollamaUrl,
      embeddingModel: detected.embeddingModel,
      embeddingDimensions: detected.embeddingDimensions,
    };

    await ctx.emitProgress('Connecting to RAG database...');
    const conn = await resolveRagConnection(prefs, ctx.db, detected.projectName);
    if (!conn) {
      ctx.logger.warn('rag connection resolved to null');
      return {
        kbChunkCount: 0,
        codeChunkCount: 0,
        kbFileCount: 0,
        codeFileCount: 0,
        embeddingDimensions: detected.embeddingDimensions,
        tableName: RAG_TABLE,
        usedPgvector: false,
        ragMode: detected.ragMode,
        usedOllama: false,
      };
    }

    try {
      await ctx.emitProgress('Creating RAG schema and indexes...');
      const { usedPgvector } = await ensureRagSchema(conn);

      // Resolve repository_id first — the truncate path scopes by repo so
      // re-onboarding the same repo actually wipes its prior chunks
      // (pre-fix scoped by task_id, which always-empty for the current task
      // before the insert started; the wipe was a no-op).
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

      const values = args.formValues as { truncateExisting?: boolean };
      if (values.truncateExisting !== false) {
        await ctx.emitProgress('Clearing existing RAG data...');
        if (repositoryId) {
          await conn.pg.unsafe(`DELETE FROM ${RAG_TABLE} WHERE repository_id = $1`, [repositoryId]);
        } else {
          // Fallback for repo-less tasks: legacy task_id scope. Rare; happens
          // only for onboarding tasks whose tasks.repository_id is null.
          await conn.pg.unsafe(`DELETE FROM ${RAG_TABLE} WHERE task_id = $1`, [ctx.taskId]);
        }
      }

      const useOllama =
        detected.ollamaReachable && !!detected.ollamaUrl && !!detected.embeddingModel;

      let kbChunkCount = 0;
      let codeChunkCount = 0;
      let kbFileCount = 0;
      let codeFileCount = 0;

      // --- KB files ---
      const totalKb = detected.kbFiles.length;
      for (let fi = 0; fi < totalKb; fi += 1) {
        ctx.throwIfCancelled();
        const file = detected.kbFiles[fi]!;
        await ctx.emitProgress(`Indexing KB (${fi + 1}/${totalKb}): ${file.relPath}`);

        let text: string;
        try {
          text = await readFile(path.join(ctx.repoPath, file.relPath), 'utf8');
        } catch (err) {
          ctx.logger.warn({ err, file: file.relPath }, 'failed to read KB file; skipping');
          continue;
        }

        const sections = extractMarkdownSections(text, file.relPath);
        const chunks: RagChunk[] = [];
        for (const section of sections) {
          chunks.push(...chunkSection(section));
        }
        if (chunks.length === 0) continue;
        kbFileCount += 1;

        // Embed and insert in batches
        for (let batchStart = 0; batchStart < chunks.length; batchStart += EMBED_BATCH_SIZE) {
          ctx.throwIfCancelled();
          const batch = chunks.slice(batchStart, batchStart + EMBED_BATCH_SIZE);
          const texts = batch.map((c) => c.content);
          let embeddings: number[][];

          if (useOllama) {
            try {
              embeddings = await ollamaEmbed(detected.ollamaUrl!, detected.embeddingModel!, texts);
            } catch (err) {
              ctx.logger.warn(
                { err, file: file.relPath, batchStart },
                'Ollama failed; hash fallback',
              );
              embeddings = texts.map((t) => hashEmbed(t, detected.embeddingDimensions));
            }
          } else {
            embeddings = texts.map((t) => hashEmbed(t, detected.embeddingDimensions));
          }

          for (let i = 0; i < batch.length; i += 1) {
            const chunk = batch[i]!;
            await insertChunk(
              conn,
              usedPgvector,
              ctx.taskId,
              repositoryId,
              'kb',
              file.relPath,
              chunk.sectionId,
              chunk.chunkIndex,
              chunk.chunkHash,
              chunk.content,
              embeddings[i]!,
            );
            kbChunkCount += 1;
          }
        }
      }

      // --- Code files ---
      const totalCode = detected.codeFiles.length;
      for (let fi = 0; fi < totalCode; fi += 1) {
        ctx.throwIfCancelled();
        const file = detected.codeFiles[fi]!;
        await ctx.emitProgress(`Indexing code (${fi + 1}/${totalCode}): ${file.relPath}`);

        let text: string;
        try {
          text = await readFile(path.join(ctx.repoPath, file.relPath), 'utf8');
        } catch (err) {
          ctx.logger.warn({ err, file: file.relPath }, 'failed to read code file; skipping');
          continue;
        }

        const sections = extractCodeSections(text, file.relPath);
        const chunks: RagChunk[] = [];
        for (const section of sections) {
          chunks.push(...chunkSection(section));
        }
        if (chunks.length === 0) continue;
        codeFileCount += 1;

        for (let batchStart = 0; batchStart < chunks.length; batchStart += EMBED_BATCH_SIZE) {
          ctx.throwIfCancelled();
          const batch = chunks.slice(batchStart, batchStart + EMBED_BATCH_SIZE);
          const texts = batch.map((c) => c.content);
          let embeddings: number[][];

          if (useOllama) {
            try {
              embeddings = await ollamaEmbed(detected.ollamaUrl!, detected.embeddingModel!, texts);
            } catch (err) {
              ctx.logger.warn(
                { err, file: file.relPath, batchStart },
                'Ollama failed; hash fallback',
              );
              embeddings = texts.map((t) => hashEmbed(t, detected.embeddingDimensions));
            }
          } else {
            embeddings = texts.map((t) => hashEmbed(t, detected.embeddingDimensions));
          }

          for (let i = 0; i < batch.length; i += 1) {
            const chunk = batch[i]!;
            await insertChunk(
              conn,
              usedPgvector,
              ctx.taskId,
              repositoryId,
              'code',
              file.relPath,
              chunk.sectionId,
              chunk.chunkIndex,
              chunk.chunkHash,
              chunk.content,
              embeddings[i]!,
            );
            codeChunkCount += 1;
          }
        }
      }

      await ctx.emitProgress(
        `RAG populate complete: ${kbChunkCount} KB chunks from ${kbFileCount} files, ${codeChunkCount} code chunks from ${codeFileCount} files.`,
      );

      ctx.logger.info(
        {
          kbChunkCount,
          codeChunkCount,
          kbFileCount,
          codeFileCount,
          usedPgvector,
          usedOllama: useOllama,
          ragMode: detected.ragMode,
        },
        'rag populate apply complete',
      );
      return {
        kbChunkCount,
        codeChunkCount,
        kbFileCount,
        codeFileCount,
        embeddingDimensions: detected.embeddingDimensions,
        tableName: RAG_TABLE,
        usedPgvector,
        ragMode: detected.ragMode,
        usedOllama: useOllama,
      };
    } finally {
      await conn.close();
    }
  },
};
