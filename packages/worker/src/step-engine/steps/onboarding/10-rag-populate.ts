import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, pathExists } from './_helpers.js';

export interface RagSourceFile {
  relPath: string;
  sizeBytes: number;
}

export interface RagPopulateDetect {
  sourceFiles: RagSourceFile[];
  extensionAvailable: boolean;
}

export interface RagPopulateApply {
  chunkCount: number;
  fileCount: number;
  embeddingDimensions: number;
  tableName: string;
  usedPgvector: boolean;
}

const EMBEDDING_DIMENSIONS = 384;
const CHUNK_SIZE_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 150;
const SOURCE_PREFIXES = ['.claude/knowledge_base/', '.claude/skills/', '.claude/agents/'];
const ROOT_FILES = ['CLAUDE.md', 'AGENTS.md'];

async function collectSourceFiles(repo: string): Promise<RagSourceFile[]> {
  const out: RagSourceFile[] = [];

  for (const rel of ROOT_FILES) {
    const full = path.join(repo, rel);
    if (await pathExists(full)) {
      try {
        const text = await readFile(full, 'utf8');
        out.push({ relPath: rel, sizeBytes: Buffer.byteLength(text, 'utf8') });
      } catch {
        continue;
      }
    }
  }

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

function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= CHUNK_SIZE_CHARS) return [trimmed];
  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(trimmed.length, start + CHUNK_SIZE_CHARS);
    chunks.push(trimmed.slice(start, end));
    if (end >= trimmed.length) break;
    start = end - CHUNK_OVERLAP_CHARS;
  }
  return chunks;
}

export function hashEmbed(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const out = new Array<number>(dimensions).fill(0);
  let blockIndex = 0;
  let produced = 0;
  while (produced < dimensions) {
    const hash = createHash('sha256').update(`${blockIndex}:${text}`).digest();
    for (let i = 0; i < hash.length && produced < dimensions; i += 2) {
      const raw = hash.readUInt16BE(i);
      out[produced] = raw / 65535 - 0.5;
      produced += 1;
    }
    blockIndex += 1;
  }
  let sumSq = 0;
  for (const v of out) sumSq += v * v;
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < out.length; i += 1) {
    out[i] = out[i]! / norm;
  }
  return out;
}

function vectorLiteral(values: number[]): string {
  return `[${values.map((v) => v.toFixed(6)).join(',')}]`;
}

async function ensurePgvector(
  ctx: StepContext,
): Promise<{ usedPgvector: boolean; tableName: string }> {
  let usedPgvector = true;
  try {
    await ctx.db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (err) {
    ctx.logger.warn(
      { err },
      'pgvector extension unavailable; falling back to text-encoded embeddings',
    );
    usedPgvector = false;
  }

  if (usedPgvector) {
    await ctx.db.execute(sql`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repository_id uuid REFERENCES repositories(id) ON DELETE SET NULL,
        file_path text NOT NULL,
        chunk_index integer NOT NULL,
        content text NOT NULL,
        embedding vector(${sql.raw(String(EMBEDDING_DIMENSIONS))}) NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
  } else {
    await ctx.db.execute(sql`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repository_id uuid REFERENCES repositories(id) ON DELETE SET NULL,
        file_path text NOT NULL,
        chunk_index integer NOT NULL,
        content text NOT NULL,
        embedding_json jsonb NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
  }

  await ctx.db.execute(sql`
    CREATE INDEX IF NOT EXISTS rag_chunks_task_id_idx ON rag_chunks(task_id)
  `);

  return { usedPgvector, tableName: 'rag_chunks' };
}

async function checkExtensionAvailable(ctx: StepContext): Promise<boolean> {
  try {
    const result = (await ctx.db.execute(
      sql`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`,
    )) as unknown;
    if (Array.isArray(result)) return result.length > 0;
    return false;
  } catch {
    return false;
  }
}

async function resolveRepositoryId(ctx: StepContext): Promise<string | null> {
  try {
    const result = (await ctx.db.execute(
      sql`SELECT repository_id FROM tasks WHERE id = ${ctx.taskId} LIMIT 1`,
    )) as unknown;
    if (!Array.isArray(result) || result.length === 0) return null;
    const first = result[0] as { repository_id?: string | null } | undefined;
    return first?.repository_id ?? null;
  } catch {
    return null;
  }
}

export const ragPopulateStep: StepDefinition<RagPopulateDetect, RagPopulateApply> = {
  metadata: {
    id: '10-rag-populate',
    workflowType: 'onboarding',
    index: 13,
    title: 'Populate RAG index',
    description:
      'Chunks the generated knowledge base, agents, skills, CLAUDE.md and AGENTS.md, computes deterministic embeddings, and writes them to the rag_chunks table. Ensures the pgvector extension when available and falls back to a jsonb-encoded embedding column otherwise.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RagPopulateDetect> {
    const sourceFiles = await collectSourceFiles(ctx.repoPath);
    const extensionAvailable = await checkExtensionAvailable(ctx);
    ctx.logger.info(
      { fileCount: sourceFiles.length, extensionAvailable },
      'rag populate detect complete',
    );
    return { sourceFiles, extensionAvailable };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Populate RAG index',
      description: `Will chunk ${detected.sourceFiles.length} source file(s) and write embeddings to rag_chunks. ${
        detected.extensionAvailable
          ? 'pgvector extension detected.'
          : 'pgvector not detected; will fall back to jsonb embeddings.'
      }`,
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
    const values = args.formValues as { truncateExisting?: boolean };

    const { usedPgvector, tableName } = await ensurePgvector(ctx);
    const repositoryId = await resolveRepositoryId(ctx);

    if (values.truncateExisting !== false) {
      await ctx.db.execute(sql`DELETE FROM rag_chunks WHERE task_id = ${ctx.taskId}`);
    }

    let chunkCount = 0;
    let fileCount = 0;

    for (const file of detected.sourceFiles) {
      let text: string;
      try {
        text = await readFile(path.join(ctx.repoPath, file.relPath), 'utf8');
      } catch (err) {
        ctx.logger.warn(
          { err, file: file.relPath },
          'rag populate failed to read source file; skipping',
        );
        continue;
      }
      const chunks = chunkText(text);
      if (chunks.length === 0) continue;
      fileCount += 1;

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const embedding = hashEmbed(chunk);
        if (usedPgvector) {
          const literal = vectorLiteral(embedding);
          await ctx.db.execute(sql`
            INSERT INTO rag_chunks (task_id, repository_id, file_path, chunk_index, content, embedding)
            VALUES (
              ${ctx.taskId},
              ${repositoryId},
              ${file.relPath},
              ${index},
              ${chunk},
              ${literal}::vector
            )
          `);
        } else {
          const json = JSON.stringify(embedding);
          await ctx.db.execute(sql`
            INSERT INTO rag_chunks (task_id, repository_id, file_path, chunk_index, content, embedding_json)
            VALUES (
              ${ctx.taskId},
              ${repositoryId},
              ${file.relPath},
              ${index},
              ${chunk},
              ${json}::jsonb
            )
          `);
        }
        chunkCount += 1;
      }
    }

    ctx.logger.info({ chunkCount, fileCount, usedPgvector }, 'rag populate apply complete');
    return {
      chunkCount,
      fileCount,
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      tableName,
      usedPgvector,
    };
  },
};
