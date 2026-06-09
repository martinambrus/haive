import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
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
  isMinifiedPath,
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
  /** How the index was populated this run. */
  mode: 'incremental' | 'full';
  /** Chunks actually embedded + (up)serted this run. */
  chunksEmbedded: number;
  /** Chunks skipped because their content hash was unchanged (incremental). */
  chunksSkipped: number;
  /** Stale chunks deleted because their source disappeared (incremental). */
  chunksDeleted: number;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SOURCE_PREFIXES = ['.claude/knowledge_base/'];

const CODE_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  // Haive's per-task git worktrees (<repo>/.haive/worktrees/) are full repo
  // copies — never index them as project source.
  '.haive',
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
      // Skip minified / generated bundles even when their extension matches.
      if (isMinifiedPath(rel)) return false;
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

// ON CONFLICT suffix for upsert (incremental mode). Targets the partial unique
// index uq_rag_repo_source_section_chunk; the content_tsv trigger fires on
// UPDATE too, so BM25 stays correct.
const UPSERT_VECTOR =
  ' ON CONFLICT (repository_id, source_path, section_id, chunk_index) WHERE repository_id IS NOT NULL' +
  ' DO UPDATE SET task_id = EXCLUDED.task_id, source_type = EXCLUDED.source_type,' +
  ' chunk_hash = EXCLUDED.chunk_hash, content = EXCLUDED.content, vector = EXCLUDED.vector';
const UPSERT_JSON =
  ' ON CONFLICT (repository_id, source_path, section_id, chunk_index) WHERE repository_id IS NOT NULL' +
  ' DO UPDATE SET task_id = EXCLUDED.task_id, source_type = EXCLUDED.source_type,' +
  ' chunk_hash = EXCLUDED.chunk_hash, content = EXCLUDED.content, embedding_json = EXCLUDED.embedding_json';

export async function insertChunk(
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
  upsert: boolean,
): Promise<void> {
  if (usedPgvector) {
    const literal = vectorLiteral(embedding);
    await conn.pg.unsafe(
      `INSERT INTO ${RAG_TABLE} (task_id, repository_id, source_type, source_path, section_id, chunk_index, chunk_hash, content, vector)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)${upsert ? UPSERT_VECTOR : ''}`,
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)${upsert ? UPSERT_JSON : ''}`,
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
/* Incremental population helpers                                      */
/* ------------------------------------------------------------------ */

interface ExistingChunk {
  sourcePath: string;
  sectionId: string;
  chunkIndex: number;
  hash: string;
}

interface IncrementalSync {
  /** key -> existing chunk record, for this repo. */
  existing: Map<string, ExistingChunk>;
  /** keys seen this run, accumulated across KB + code so stale rows can be
   *  deleted afterward. */
  seen: Set<string>;
}

/** Stable composite key for a chunk row. Paths and section ids never contain
 *  NUL, so it round-trips unambiguously. */
export function chunkKey(sourcePath: string, sectionId: string, chunkIndex: number): string {
  return `${sourcePath} ${sectionId} ${chunkIndex}`;
}

/** Keys present in the existing index but not re-seen this run — their source
 *  chunk disappeared (file/section removed or shrank) and must be deleted. */
export function computeStaleKeys(
  existingKeys: Iterable<string>,
  seen: ReadonlySet<string>,
): string[] {
  const stale: string[] = [];
  for (const k of existingKeys) if (!seen.has(k)) stale.push(k);
  return stale;
}

/** Resolve the populate mode. Incremental is the default; legacy callers that
 *  pass `truncateExisting: true` (smoke tests) map to full. Incremental needs
 *  repo scope (the partial unique index only covers non-null repository_id), so
 *  a repo-less task always uses full. */
export function resolvePopulateMode(
  formValues: unknown,
  repositoryId: string | null,
): 'incremental' | 'full' {
  if (!repositoryId) return 'full';
  const v = (formValues ?? {}) as { populateMode?: string; truncateExisting?: boolean };
  if (v.populateMode === 'full' || v.populateMode === 'incremental') return v.populateMode;
  if (v.truncateExisting === true) return 'full';
  return 'incremental';
}

async function loadExistingChunkHashes(
  conn: RagConnection,
  repositoryId: string,
): Promise<Map<string, ExistingChunk>> {
  const rows = (await conn.pg.unsafe(
    `SELECT source_path, section_id, chunk_index, chunk_hash FROM ${RAG_TABLE} WHERE repository_id = $1`,
    [repositoryId],
  )) as unknown as Array<{
    source_path: string;
    section_id: string;
    chunk_index: number;
    chunk_hash: string;
  }>;
  const map = new Map<string, ExistingChunk>();
  for (const r of rows) {
    map.set(chunkKey(r.source_path, r.section_id, r.chunk_index), {
      sourcePath: r.source_path,
      sectionId: r.section_id,
      chunkIndex: r.chunk_index,
      hash: r.chunk_hash,
    });
  }
  return map;
}

/** Dimension of the existing embeddings for a repo, or null when none/unknown.
 *  Used to force a full rebuild if the embedding model's dimension changed. */
async function existingVectorDims(
  conn: RagConnection,
  usedPgvector: boolean,
  repositoryId: string,
): Promise<number | null> {
  try {
    const col = usedPgvector ? 'vector_dims(vector)' : 'jsonb_array_length(embedding_json)';
    const guard = usedPgvector ? 'vector IS NOT NULL' : 'embedding_json IS NOT NULL';
    const rows = (await conn.pg.unsafe(
      `SELECT ${col} AS dims FROM ${RAG_TABLE} WHERE repository_id = $1 AND ${guard} LIMIT 1`,
      [repositoryId],
    )) as unknown as Array<{ dims: number | null }>;
    const d = rows[0]?.dims;
    return typeof d === 'number' ? d : null;
  } catch {
    return null;
  }
}

async function deleteStaleChunks(
  conn: RagConnection,
  repositoryId: string,
  stale: ExistingChunk[],
): Promise<number> {
  let deleted = 0;
  const BATCH = 200;
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    const params: (string | number)[] = [repositoryId];
    const tuples = batch.map((c, j) => {
      const base = 2 + j * 3;
      params.push(c.sourcePath, c.sectionId, c.chunkIndex);
      return `($${base}, $${base + 1}, $${base + 2})`;
    });
    const res = (await conn.pg.unsafe(
      `DELETE FROM ${RAG_TABLE} WHERE repository_id = $1 AND (source_path, section_id, chunk_index) IN (${tuples.join(', ')})`,
      params,
    )) as unknown as { count?: number };
    deleted += typeof res?.count === 'number' ? res.count : batch.length;
  }
  return deleted;
}

/** Embed + store one file's chunks. In incremental mode (sync != null) chunks
 *  whose content hash already matches the index are skipped (no re-embed) and
 *  the rest are upserted; in full mode every chunk is inserted. Returns how many
 *  were embedded vs skipped. */
async function embedAndStore(opts: {
  ctx: StepContext;
  conn: RagConnection;
  usedPgvector: boolean;
  taskId: string;
  repositoryId: string | null;
  sourceType: 'kb' | 'code';
  filePath: string;
  chunks: RagChunk[];
  useOllama: boolean;
  ollamaUrl: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number;
  sync: IncrementalSync | null;
}): Promise<{ embedded: number; skipped: number }> {
  const { sync } = opts;
  const toEmbed: RagChunk[] = [];
  let skipped = 0;
  for (const chunk of opts.chunks) {
    if (sync) {
      const key = chunkKey(opts.filePath, chunk.sectionId, chunk.chunkIndex);
      sync.seen.add(key);
      if (sync.existing.get(key)?.hash === chunk.chunkHash) {
        skipped += 1;
        continue;
      }
    }
    toEmbed.push(chunk);
  }

  let embedded = 0;
  for (let batchStart = 0; batchStart < toEmbed.length; batchStart += EMBED_BATCH_SIZE) {
    opts.ctx.throwIfCancelled();
    const batch = toEmbed.slice(batchStart, batchStart + EMBED_BATCH_SIZE);
    const texts = batch.map((c) => c.content);
    let embeddings: number[][];
    if (opts.useOllama) {
      try {
        embeddings = await ollamaEmbed(opts.ollamaUrl!, opts.embeddingModel!, texts);
      } catch (err) {
        opts.ctx.logger.warn(
          { err, file: opts.filePath, batchStart },
          'Ollama failed; hash fallback',
        );
        embeddings = texts.map((t) => hashEmbed(t, opts.embeddingDimensions));
      }
    } else {
      embeddings = texts.map((t) => hashEmbed(t, opts.embeddingDimensions));
    }
    for (let i = 0; i < batch.length; i += 1) {
      const chunk = batch[i]!;
      await insertChunk(
        opts.conn,
        opts.usedPgvector,
        opts.taskId,
        opts.repositoryId,
        opts.sourceType,
        opts.filePath,
        chunk.sectionId,
        chunk.chunkIndex,
        chunk.chunkHash,
        chunk.content,
        embeddings[i]!,
        sync !== null,
      );
      embedded += 1;
    }
  }
  return { embedded, skipped };
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
          type: 'radio',
          id: 'populateMode',
          label: 'Population mode',
          options: [
            {
              value: 'incremental',
              label: 'Incremental — only re-embed new/changed chunks, drop removed ones (fast)',
            },
            {
              value: 'full',
              label: 'Full rebuild — re-embed everything (use after changing the embedding model)',
            },
          ],
          default: 'incremental',
          required: true,
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
        mode: 'full',
        chunksEmbedded: 0,
        chunksSkipped: 0,
        chunksDeleted: 0,
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
        mode: 'full',
        chunksEmbedded: 0,
        chunksSkipped: 0,
        chunksDeleted: 0,
      };
    }

    try {
      await ctx.emitProgress('Creating RAG schema and indexes...');
      const { usedPgvector } = await ensureRagSchema(conn);

      // Resolve repository_id first — the truncate path scopes by repo so
      // re-onboarding the same repo actually wipes its prior chunks
      // (pre-fix scoped by task_id, which always-empty for the current task
      // before the insert started; the wipe was a no-op).
      // NB: a prior raw ctx.db.execute({sql,params}) call here failed at runtime
      // (wrong postgres-js driver shape, swallowed by catch) and left
      // repository_id NULL on every inserted row — which broke the truncate
      // path AND left rows unscoped so the workflow RAG sync (02-pre-rag-sync)
      // could not dedup against them and re-ingested duplicates. Use the same
      // drizzle query the rest of the codebase uses.
      const taskRow = await ctx.db.query.tasks.findFirst({
        where: eq(schema.tasks.id, ctx.taskId),
        columns: { repositoryId: true },
      });
      const repositoryId = taskRow?.repositoryId ?? null;

      // Resolve populate mode. Incremental (default) skips re-embedding chunks
      // whose content is unchanged; full rebuilds from scratch. Legacy
      // truncateExisting:true maps to full; a changed embedding dimension also
      // forces full (mixing dims would corrupt search).
      let mode = resolvePopulateMode(args.formValues, repositoryId);
      if (mode === 'incremental' && repositoryId) {
        const existingDims = await existingVectorDims(conn, usedPgvector, repositoryId);
        if (existingDims !== null && existingDims !== detected.embeddingDimensions) {
          ctx.logger.warn(
            { existingDims, requested: detected.embeddingDimensions },
            'rag embedding dimensions changed — forcing full rebuild',
          );
          mode = 'full';
        }
      }

      let sync: IncrementalSync | null = null;
      if (mode === 'full') {
        await ctx.emitProgress('Clearing existing RAG data...');
        if (repositoryId) {
          await conn.pg.unsafe(`DELETE FROM ${RAG_TABLE} WHERE repository_id = $1`, [repositoryId]);
        } else {
          // Fallback for repo-less tasks: legacy task_id scope.
          await conn.pg.unsafe(`DELETE FROM ${RAG_TABLE} WHERE task_id = $1`, [ctx.taskId]);
        }
      } else {
        await ctx.emitProgress('Loading existing RAG index for incremental update...');
        sync = { existing: await loadExistingChunkHashes(conn, repositoryId!), seen: new Set() };
      }

      const useOllama =
        detected.ollamaReachable && !!detected.ollamaUrl && !!detected.embeddingModel;

      let kbChunkCount = 0;
      let codeChunkCount = 0;
      let kbFileCount = 0;
      let codeFileCount = 0;
      let chunksEmbedded = 0;
      let chunksSkipped = 0;

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
        kbChunkCount += chunks.length;
        const kbRes = await embedAndStore({
          ctx,
          conn,
          usedPgvector,
          taskId: ctx.taskId,
          repositoryId,
          sourceType: 'kb',
          filePath: file.relPath,
          chunks,
          useOllama,
          ollamaUrl: detected.ollamaUrl,
          embeddingModel: detected.embeddingModel,
          embeddingDimensions: detected.embeddingDimensions,
          sync,
        });
        chunksEmbedded += kbRes.embedded;
        chunksSkipped += kbRes.skipped;
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
        codeChunkCount += chunks.length;
        const codeRes = await embedAndStore({
          ctx,
          conn,
          usedPgvector,
          taskId: ctx.taskId,
          repositoryId,
          sourceType: 'code',
          filePath: file.relPath,
          chunks,
          useOllama,
          ollamaUrl: detected.ollamaUrl,
          embeddingModel: detected.embeddingModel,
          embeddingDimensions: detected.embeddingDimensions,
          sync,
        });
        chunksEmbedded += codeRes.embedded;
        chunksSkipped += codeRes.skipped;
      }

      let chunksDeleted = 0;
      if (sync) {
        const staleKeys = computeStaleKeys(sync.existing.keys(), sync.seen);
        if (staleKeys.length > 0) {
          await ctx.emitProgress(`Removing ${staleKeys.length} stale chunk(s)...`);
          chunksDeleted = await deleteStaleChunks(
            conn,
            repositoryId!,
            staleKeys.map((k) => sync!.existing.get(k)!),
          );
        }
      }

      await ctx.emitProgress(
        `RAG ${mode} complete: embedded ${chunksEmbedded}, skipped ${chunksSkipped}, deleted ${chunksDeleted} ` +
          `(${kbChunkCount} KB chunks from ${kbFileCount} files, ${codeChunkCount} code chunks from ${codeFileCount} files).`,
      );

      ctx.logger.info(
        {
          mode,
          kbChunkCount,
          codeChunkCount,
          kbFileCount,
          codeFileCount,
          chunksEmbedded,
          chunksSkipped,
          chunksDeleted,
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
        mode,
        chunksEmbedded,
        chunksSkipped,
        chunksDeleted,
      };
    } finally {
      await conn.close();
    }
  },
};
