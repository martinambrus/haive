import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
} from '@haive/shared';
import {
  INVESTIGATIONS_DIR,
  KNOWLEDGE_SOURCE_PREFIXES,
  LEARNINGS_DIR,
} from '@haive/shared/knowledge-paths';
import type { OnboardingEnvironmentMirror, OnboardingToolingMirror } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { listFilesMatching, loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { loadScopeExcludeGlobs } from '../onboarding/_scope.js';
import { collectCodeFiles, type CodeCollectOptions } from '../onboarding/_rag-collect.js';
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
  capChunks,
  contextHeader,
  MAX_FILE_BYTES,
  type RagChunk,
} from '../onboarding/_rag-chunkers.js';
import { warmOllamaModel, vectorLiteral } from '../onboarding/_rag-embed.js';
import { detectEmbedDevice, embedDeviceWarning, type EmbedDevice } from '../_embed-device.js';
import {
  clearRagEmbedDegraded,
  composeRagWarning,
  embedBatch,
  loadRagEmbedHealth,
  ragEmbedWarning,
  recordRagEmbedDegraded,
  resolveEmbedBatchSize,
} from '../_rag-embed-health.js';
import { indexTaskEmbedding, TASK_EMBED_SOURCE_TYPE } from './_task-embedding.js';

/* ------------------------------------------------------------------ */
/* Shared RAG indexing — used by 02-pre-rag-sync (run start, indexes  */
/* the main checkout) and 11c-rag-reindex (post-commit, indexes the   */
/* worktree so the just-written KB/learnings are searchable this run).*/
/* ------------------------------------------------------------------ */

export type RagSourceType = 'kb' | 'code' | 'learning' | 'runbook';

export const SOURCE_PREFIXES: readonly string[] = KNOWLEDGE_SOURCE_PREFIXES;

/** Type a markdown source by its path so RAG can filter/boost by knowledge kind:
 *  bug run-books (investigations), durable learnings, and general KB articles. */
export function classifyKbSourceType(relPath: string): RagSourceType {
  if (relPath.startsWith(`${INVESTIGATIONS_DIR}/`)) return 'runbook';
  if (relPath.startsWith(`${LEARNINGS_DIR}/`)) return 'learning';
  return 'kb';
}

export async function collectKbFiles(repo: string): Promise<string[]> {
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

/** Code-file collection is SHARED with onboarding's 10-rag-populate — see
 *  `../onboarding/_rag-collect.ts`. Re-exported here so the two steps that
 *  consume it keep importing from this module. */
export { collectCodeFiles };
export type { CodeCollectOptions };

export interface RagSyncResult {
  performed: boolean;
  reason: string;
  inserted: number;
  updated: number;
  skipped: number;
  deleted: number;
  /** Whether embeddings ran on the GPU or silently fell back to CPU. 'unknown'
   *  when Ollama wasn't used or the host has no GPU (nothing to warn about). */
  embeddingDevice: EmbedDevice;
  /** Chunks left UNINDEXED because their embed failed under strict mode. Absent
   *  from the index rather than stored with a meaningless vector — a missing row
   *  is honest, a hash row silently outranks real hits. */
  embedSkippedChunks: number;
  /** Why the embeds failed, for the step banner. Null when nothing failed. */
  embedFailureReason: string | null;
}

export interface RagSyncResolved {
  ragConfigured: boolean;
  ragMode: RagMode;
  ragToolingPrefs: RagToolingPrefs | null;
  projectName: string;
  /** The SAME collector inputs onboarding's 10-rag-populate used, so a workflow
   *  re-index collects the set onboarding indexed rather than its own. */
  codeCollect: CodeCollectOptions;
}

/** Map a persisted 04-tooling `tooling` object to RAG sync prefs. Shared by the
 *  repo-mirror read and the onboarding-task-output fallback. */
export function toRagPrefs(t: Record<string, unknown>): RagToolingPrefs {
  return {
    ragMode: ((t.ragMode as string) ?? 'none') as RagMode,
    ragConnectionString: (t.ragConnectionString as string) || null,
    ollamaUrl: (t.ollamaUrl as string) || null,
    embeddingModel: (t.embeddingModel as string) || null,
    embeddingDimensions: typeof t.embeddingDimensions === 'number' ? t.embeddingDimensions : 2560,
  };
}

/** Resolve the repo's RAG prefs + project name. Prefers the repo-level
 *  onboarding mirror (repositories.onboarding_tooling / onboarding_environment),
 *  which survives a clone to another machine; falls back to the most recent
 *  onboarding task's step outputs (04-tooling-infrastructure + 01-env-detect)
 *  for repos onboarded before the mirror columns existed. Shared by both steps'
 *  detect phases.
 *
 *  Also resolves the code-collector inputs. Those have NO repo-level mirror, so
 *  the onboarding task is read for them unconditionally: 09_7's folder and
 *  extension picks plus 01-env-detect's custom-code exclude heuristic. Anything
 *  absent stays undefined, which the collector reads as "no restriction" — the
 *  behaviour a repo onboarded before 09_7 existed already had. */
export async function resolveRagSyncPrefs(ctx: StepContext): Promise<RagSyncResolved> {
  const taskRow = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
  });
  const repositoryId = taskRow?.repositoryId ?? null;

  let ragPrefs: RagToolingPrefs | null = null;
  let projectName = 'default';
  // The per-repo scope deny list is authoritative and lives on the repository
  // row, so it is available even when no onboarding task survives.
  const exclude: string[] = await loadScopeExcludeGlobs(ctx.db, ctx.taskId);
  let selectedDirs: string[] | undefined;
  let extensionSet: string[] | undefined;

  if (repositoryId) {
    // Col-first: the repo mirror is authoritative when present.
    const repo = await ctx.db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
      columns: { onboardingTooling: true, onboardingEnvironment: true },
    });
    const toolingMirror = repo?.onboardingTooling as OnboardingToolingMirror | null | undefined;
    const envMirror = repo?.onboardingEnvironment as OnboardingEnvironmentMirror | null | undefined;

    if (
      toolingMirror?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION &&
      toolingMirror.tooling
    ) {
      ragPrefs = toRagPrefs(toolingMirror.tooling);
    }
    if (envMirror?.schemaVersion === ONBOARDING_ENVIRONMENT_SCHEMA_VERSION) {
      const p = (envMirror.envDetectData as { project?: { name?: string } } | undefined)?.project;
      projectName = p?.name ?? 'default';
    }

    // The onboarding task is always read: it is the ONLY source of 09_7's
    // selection, and it also backfills whatever the mirror lacked (legacy
    // repos, or a mirror missing the project name).
    const onboardingTask = await ctx.db.query.tasks.findFirst({
      where: and(eq(schema.tasks.repositoryId, repositoryId), eq(schema.tasks.type, 'onboarding')),
      orderBy: [desc(schema.tasks.createdAt)],
    });

    if (onboardingTask) {
      if (!ragPrefs) {
        const toolingPrev = await loadPreviousStepOutput(
          ctx.db,
          onboardingTask.id,
          '04-tooling-infrastructure',
        );
        if (toolingPrev?.output) {
          const o = toolingPrev.output as { tooling?: Record<string, unknown> };
          ragPrefs = toRagPrefs(o.tooling ?? {});
        }
      }

      const envPrev = await loadPreviousStepOutput(ctx.db, onboardingTask.id, '01-env-detect');
      const envData = (
        envPrev?.detect as {
          data?: {
            project?: { name?: string };
            paths?: { customCodePaths?: { exclude?: string[] } };
          };
        } | null
      )?.data;
      if (projectName === 'default') {
        projectName = envData?.project?.name ?? 'default';
      }
      exclude.push(...(envData?.paths?.customCodePaths?.exclude ?? []));

      const ragSourcePrev = await loadPreviousStepOutput(
        ctx.db,
        onboardingTask.id,
        '09_7-rag-source-selection',
      );
      const ragSourceOutput = ragSourcePrev?.output as {
        selectedDirs?: string[];
        extensionSet?: string[];
      } | null;
      selectedDirs = ragSourceOutput?.selectedDirs;
      extensionSet = ragSourceOutput?.extensionSet;
    }
  }

  return {
    ragConfigured: ragPrefs !== null && ragPrefs.ragMode !== 'none',
    ragMode: ragPrefs?.ragMode ?? 'none',
    ragToolingPrefs: ragPrefs,
    projectName,
    codeCollect: { exclude, selectedDirs, extensionSet },
  };
}

export interface RunRagIndexOpts {
  /** Filesystem root to index. 02 passes the main checkout (`ctx.repoPath`); 11c
   *  passes the worktree so the just-written KB/learnings are picked up. */
  repoPath: string;
  prefs: RagToolingPrefs;
  projectName: string;
  ollamaReachable: boolean;
  /** From `resolveRagSyncPrefs`. Must be the same value the caller's detect
   *  counted with — a narrower set here than at detect time means the orphan
   *  sweep below deletes the difference. */
  codeCollect: CodeCollectOptions;
}

const EMPTY_RESULT = (reason: string): RagSyncResult => ({
  performed: false,
  reason,
  inserted: 0,
  updated: 0,
  skipped: 0,
  deleted: 0,
  embeddingDevice: 'unknown',
  embedSkippedChunks: 0,
  embedFailureReason: null,
});

/** Incremental, content-hash-deduped RAG index of `opts.repoPath`'s KB + code.
 *  Reconciles: inserts new chunks, re-embeds changed ones, and DELETES stale
 *  chunks/files (scoped by repository_id) so removals propagate to RAG. */
export async function runRagIndexSync(
  ctx: StepContext,
  opts: RunRagIndexOpts,
): Promise<RagSyncResult> {
  const { repoPath, prefs, projectName, ollamaReachable, codeCollect } = opts;

  await ctx.emitProgress('Connecting to RAG database...');
  const conn = await resolveRagConnection(prefs, ctx.db, projectName);
  if (!conn) return EMPTY_RESULT('connection resolved to null');

  try {
    await ctx.emitProgress('Ensuring RAG schema...');
    const { usedPgvector } = await ensureRagSchema(conn);
    const useOllama = ollamaReachable && !!prefs.ollamaUrl && !!prefs.embeddingModel;

    // Resolve repository_id first — required for dedup (without it we'd re-embed
    // the same content on every task) and for the per-repo embed-health record, and
    // bailing here saves a pointless model warm. Bail with a logged warning rather
    // than silently filling the table.
    const taskRow = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { repositoryId: true, title: true, description: true },
    });
    const repositoryId = taskRow?.repositoryId ?? null;
    if (!repositoryId) {
      ctx.logger.warn(
        { taskId: ctx.taskId },
        'rag sync skipped: task has no repository_id, dedup not safe',
      );
      return EMPTY_RESULT('task has no repository_id');
    }
    const health = await loadRagEmbedHealth(ctx.db, repositoryId);

    let embedDevice: EmbedDevice = 'unknown';
    if (useOllama) {
      // Warm the embedding model once so a cold (slow-to-load) model does not
      // time out every batch into hash fallback; keep_alive keeps it resident.
      await ctx.emitProgress('Warming embedding model (first load can take a minute)...');
      const warmed = await warmOllamaModel(prefs.ollamaUrl!, prefs.embeddingModel!);
      ctx.logger.info(
        { model: prefs.embeddingModel, warmed },
        warmed ? 'embedding model warmed' : 'embedding model warmup failed (will hash-fallback)',
      );
      // After warm the model is resident, so /api/ps reports GPU vs CPU placement.
      // detectEmbedDevice warns loudly if it fell back to CPU under GPU mode.
      if (warmed) {
        embedDevice = await detectEmbedDevice(ctx.logger, prefs.ollamaUrl!, prefs.embeddingModel!);
      }
    }
    // Surface a CPU fallback and any carried-over embed degradation as a standalone
    // amber banner on the step (set once; a per-file progress line would otherwise
    // bury it). Clears to null on a healthy/unknown run so a stale warning from a
    // prior pass does not linger. Re-written after the loop with this run's result.
    await ctx.db
      .update(schema.taskSteps)
      .set({
        warningMessage: composeRagWarning(embedDeviceWarning(embedDevice), ragEmbedWarning(health)),
      })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let deleted = 0;
    let embedSkippedChunks = 0;
    let embedFailureReason: string | null = null;
    const embedBatchSize = await resolveEmbedBatchSize();

    const kbFiles = await collectKbFiles(repoPath);
    const codeFiles = await collectCodeFiles(repoPath, codeCollect);

    const allFiles: Array<{ relPath: string; sourceType: RagSourceType }> = [
      ...kbFiles.map((r) => ({ relPath: r, sourceType: classifyKbSourceType(r) })),
      ...codeFiles.map((r) => ({ relPath: r, sourceType: 'code' as const })),
    ];

    // Track all source_paths we process (for stale cleanup)
    const processedPaths = new Set<string>();

    for (let fi = 0; fi < allFiles.length; fi += 1) {
      // Honor a user Stop/Cancel promptly: it sets the task failed/cancelled, which the
      // step-runner poll turns into an aborted ctx.signal. Without this check the CPU
      // embed loop runs to completion and the finished 'done' clobbers the stopped
      // state, resuming the task. Mirrors 10-rag-populate.
      ctx.throwIfCancelled();
      const { relPath, sourceType } = allFiles[fi]!;
      processedPaths.add(relPath);
      // "Scanning", not "Syncing": this fires before the hash comparison, so on a
      // healthy incremental run it is announcing a skip. A sync that correctly
      // skipped 3091 of 3620 chunks read as a full re-ingest because every file
      // scrolled past under a verb that means work. The Indexing line below is
      // emitted only when chunks are actually embedded.
      await ctx.emitProgress(`Scanning (${fi + 1}/${allFiles.length}): ${relPath}`);

      let text: string;
      try {
        text = await readFile(path.join(repoPath, relPath), 'utf8');
      } catch {
        continue;
      }

      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_FILE_BYTES) {
        // Drop it from processedPaths so the orphan sweep below deletes whatever
        // this file had indexed before it grew past the limit — otherwise stale
        // chunks of a no-longer-indexed file would linger forever.
        processedPaths.delete(relPath);
        ctx.logger.warn(
          { relPath, bytes, max: MAX_FILE_BYTES },
          'file exceeds the RAG size limit; skipped',
        );
        continue;
      }

      const sections =
        sourceType === 'code'
          ? extractCodeSections(text, relPath)
          : extractMarkdownSections(text, relPath);
      const built: RagChunk[] = [];
      for (const section of sections) {
        built.push(
          ...chunkSection(section, { header: contextHeader(relPath, section.breadcrumb) }),
        );
      }
      const { chunks, dropped } = capChunks(built);
      if (dropped > 0) {
        ctx.logger.warn(
          { relPath, kept: chunks.length, dropped },
          'file exceeded the per-file RAG chunk budget; tail not indexed',
        );
      }

      // Claim legacy onboarding rows (repository_id IS NULL) for this file into
      // the repo scope so the dedup below matches them instead of re-ingesting
      // duplicates. First collapse duplicate NULL rows for this chunk key.
      await conn.pg.unsafe(
        `DELETE FROM ${RAG_TABLE} a USING ${RAG_TABLE} b
           WHERE a.repository_id IS NULL AND b.repository_id IS NULL
             AND a.source_path = $1 AND b.source_path = $1
             AND a.section_id = b.section_id AND a.chunk_index = b.chunk_index
             AND a.ctid > b.ctid`,
        [relPath],
      );
      // Then drop any NULL row whose key already exists under the repo (would
      // also violate the unique index on adopt), then adopt the rest.
      await conn.pg.unsafe(
        `DELETE FROM ${RAG_TABLE} n
           WHERE n.repository_id IS NULL AND n.source_path = $2
             AND EXISTS (
               SELECT 1 FROM ${RAG_TABLE} r
               WHERE r.repository_id = $1 AND r.source_path = n.source_path
                 AND r.section_id = n.section_id AND r.chunk_index = n.chunk_index)`,
        [repositoryId, relPath],
      );
      await conn.pg.unsafe(
        `UPDATE ${RAG_TABLE} SET repository_id = $1
           WHERE repository_id IS NULL AND source_path = $2`,
        [repositoryId, relPath],
      );

      // Get existing chunks for this file scoped to the repository.
      const existingRows = (await conn.pg.unsafe(
        `SELECT section_id, chunk_index, chunk_hash FROM ${RAG_TABLE}
         WHERE repository_id = $1 AND source_path = $2`,
        [repositoryId, relPath],
      )) as Array<{ section_id: string; chunk_index: number; chunk_hash: string | null }>;

      const existingMap = new Map<string, string | null>();
      for (const row of existingRows) {
        existingMap.set(`${row.section_id}:${row.chunk_index}`, row.chunk_hash);
      }

      const seenKeys = new Set<string>();
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
            `DELETE FROM ${RAG_TABLE} WHERE repository_id = $1 AND source_path = $2 AND section_id = $3 AND chunk_index = $4`,
            [repositoryId, relPath, chunk.sectionId, chunk.chunkIndex],
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
            `DELETE FROM ${RAG_TABLE} WHERE repository_id = $1 AND source_path = $2 AND section_id = $3 AND chunk_index = $4`,
            [repositoryId, relPath, sectionId, chunkIdx],
          );
          deleted += 1;
        }
      }

      if (toEmbed.length > 0) {
        await ctx.emitProgress(
          `Indexing (${fi + 1}/${allFiles.length}): ${relPath} — ${toEmbed.length} chunks`,
        );
      }

      // Embed and insert new/updated chunks in batches
      for (let batchStart = 0; batchStart < toEmbed.length; batchStart += embedBatchSize) {
        ctx.throwIfCancelled();
        const batch = toEmbed.slice(batchStart, batchStart + embedBatchSize);
        const texts = batch.map((e) => e.chunk.content);

        const outcome = await embedBatch({
          ollamaUrl: prefs.ollamaUrl,
          model: prefs.embeddingModel,
          dimensions: prefs.embeddingDimensions,
          useOllama,
          texts,
        });
        if (outcome.kind === 'failed') {
          // Leave these chunks UNINDEXED. An insert simply does not happen; an
          // update leaves the previous row in place, which is stale but still
          // points at the right file — both beat a hash vector, which cannot be
          // told apart from a real one later and outranks genuine lexical hits.
          // The run continues: a broken index must not block every task on the repo.
          embedSkippedChunks += batch.length;
          embedFailureReason ??= outcome.reason;
          ctx.logger.warn(
            { relPath, batchStart, chunks: batch.length, reason: outcome.reason },
            'embed failed; chunks left unindexed (strict mode)',
          );
          continue;
        }
        const embeddings = outcome.embeddings;

        for (let i = 0; i < batch.length; i += 1) {
          const { chunk, action } = batch[i]!;
          if (usedPgvector) {
            const literal = vectorLiteral(embeddings[i]!);
            await conn.pg.unsafe(
              `INSERT INTO ${RAG_TABLE} (task_id, repository_id, source_type, source_path, section_id, chunk_index, chunk_hash, content, vector)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
               ON CONFLICT (repository_id, source_path, section_id, chunk_index) WHERE repository_id IS NOT NULL
               DO UPDATE SET task_id = EXCLUDED.task_id, source_type = EXCLUDED.source_type, chunk_hash = EXCLUDED.chunk_hash, content = EXCLUDED.content, vector = EXCLUDED.vector`,
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
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
               ON CONFLICT (repository_id, source_path, section_id, chunk_index) WHERE repository_id IS NOT NULL
               DO UPDATE SET task_id = EXCLUDED.task_id, source_type = EXCLUDED.source_type, chunk_hash = EXCLUDED.chunk_hash, content = EXCLUDED.content, embedding_json = EXCLUDED.embedding_json`,
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

    // Delete entries for files that no longer exist in the repo. Scoped by
    // repository_id so orphans from prior tasks on the same repo also get cleaned.
    // EXCLUDE source_type='task' rows: those are the effort-estimator's task embeddings
    // (source_path = a task id, not a repo file), so they are never "orphaned files" and
    // must not be swept here (task-time estimation v2.2).
    const orphanRows = (await conn.pg.unsafe(
      `SELECT DISTINCT source_path FROM ${RAG_TABLE} WHERE repository_id = $1 AND source_type <> $2`,
      [repositoryId, TASK_EMBED_SOURCE_TYPE],
    )) as Array<{ source_path: string }>;
    for (const row of orphanRows) {
      if (!processedPaths.has(row.source_path)) {
        const result = await conn.pg.unsafe(
          `DELETE FROM ${RAG_TABLE} WHERE repository_id = $1 AND source_path = $2`,
          [repositoryId, row.source_path],
        );
        deleted += result.count;
      }
    }

    // Index THIS task's title+description as a source_type='task' embedding so future
    // estimates can semantically retrieve it as a prior-effort anchor (task-time estimation
    // v2.2). pgvector stores only (retrieval is vector-based); best-effort — a failure must
    // not fail the file sync that already succeeded.
    if (usedPgvector && useOllama && taskRow) {
      try {
        await indexTaskEmbedding(
          conn,
          prefs,
          repositoryId,
          ctx.taskId,
          taskRow.title,
          taskRow.description,
        );
      } catch (err) {
        ctx.logger.warn({ err }, 'task embedding index failed (non-fatal)');
      }
    }

    // Remember (or forget) the embed failure on the REPO, so the condition outlives
    // this step row — a manual retry nulls task_steps.output — and every later RAG
    // step can say so. Only an actual model run can clear it: a hash-mode sync
    // proves nothing about whether embeddings work.
    if (embedFailureReason) {
      await recordRagEmbedDegraded(ctx.db, repositoryId, embedFailureReason, ctx.logger);
    } else if (useOllama && health.degradedAt) {
      await clearRagEmbedDegraded(ctx.db, repositoryId, ctx.logger);
    }
    await ctx.db
      .update(schema.taskSteps)
      .set({
        warningMessage: composeRagWarning(
          embedDeviceWarning(embedDevice),
          ragEmbedWarning(
            {
              degradedAt: embedFailureReason ? (health.degradedAt ?? new Date()) : null,
              degradedReason: embedFailureReason ?? health.degradedReason,
              lexicalOnly: health.lexicalOnly,
            },
            { skippedChunks: embedSkippedChunks },
          ),
        ),
      })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));

    const skippedNote = embedSkippedChunks > 0 ? `, ${embedSkippedChunks} unindexed` : '';
    await ctx.emitProgress(
      `RAG sync complete: ${inserted} inserted, ${updated} updated, ${skipped} unchanged, ${deleted} deleted${skippedNote}.`,
    );
    ctx.logger.info(
      { inserted, updated, skipped, deleted, embedSkippedChunks },
      'rag sync complete',
    );
    return {
      performed: true,
      reason: 'sync completed',
      inserted,
      updated,
      skipped,
      deleted,
      embeddingDevice: embedDevice,
      embedSkippedChunks,
      embedFailureReason,
    };
  } finally {
    await conn.close();
  }
}
