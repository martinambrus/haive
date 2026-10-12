/**
 * Scratch RAG store builder.
 *
 * Builds a store byte-compatible with what onboarding step 10-rag-populate writes (same collector,
 * chunkers, header, hash, schema and insert) into a NEW named database haive_rag_<RAG_STORE>, so a
 * retrieval eval can run against a store built from the current chunker. It never stores a
 * hash-fallback vector: an embed error, or a vector of the wrong length, aborts the run (exit 1).
 * It refuses (exit 2, before any store connection) the live store names, a RAG_REPOSITORY_ID or a
 * store row that belongs to a repositories row, any existing database whose rows carry a different
 * repository_id, and a store built with another embedding model or width (kept in rag_build_store_meta,
 * which this script owns). Resumable: a chunk whose (source_path, section_id,
 * chunk_index, chunk_hash) is already stored for the repository is skipped.
 *
 * Run inside the worker container (has DATABASE_URL + ollama reachable):
 *   docker exec -e RAG_TREE=/var/lib/haive/repos/<user>/<repo> -e RAG_STORE=p0_eval \
 *     -e RAG_REPOSITORY_ID=<uuid> -w /app/packages/worker haive-worker \
 *     ../../node_modules/.bin/tsx scripts/rag-build-store.ts
 *
 * Env:
 *   RAG_TREE           repository tree to index (required)
 *   RAG_EXCLUDE        JSON array of anchored directory prefixes to leave out, as a saved scope
 *                      does: an own path never overrides it (default [])
 *   RAG_HEURISTIC_EXCLUDE  the same, as 01-env-detect's customCodePaths.exclude: an own path
 *                      in RAG_OWN_PATHS is still collected under it (default [])
 *   RAG_EXTENSION_SET  JSON array of code extensions, as 09_7 saved them (default: all)
 *   RAG_SELECTED_DIRS  JSON array of directories, as 09_7 saved them (default: all)
 *   RAG_OWN_PATHS      JSON array of the repository's own code paths, as 01-env-detect's
 *                      customCodePaths.include lists them: exempt from the per-file budgets (default [])
 *   RAG_STORE          NAME of the store: database haive_rag_<NAME> (required unless RAG_DRY_RUN=1)
 *   RAG_REPOSITORY_ID  uuid stamped on every row (required unless RAG_DRY_RUN=1)
 *   RAG_SOURCE_REPOSITORY_ID  uuid of the repository whose secret-mask rules apply (default: the default globs)
 *   RAG_TASK_ID        uuid stamped on every row (default: a fresh uuid, printed)
 *   RAG_OLLAMA_URL     default http://ollama:11434
 *   RAG_MODEL          default qwen3-embedding:4b
 *   RAG_DIMS           default 2560
 *   RAG_DRY_RUN        1 collects and chunks only: no database, no embed
 *   RAG_LIMIT_FILES    index only the first N code files after sorting by path (KB is always all)
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createDatabase, schema } from '@haive/database';
import { eq, inArray } from 'drizzle-orm';
import { readTextNoFollow } from '@haive/shared/fs-safe';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import {
  EMBED_BATCH_SIZE,
  ollamaEmbed,
  openExistingRagDatabase,
  ragDatabaseName,
  resolveEmbedBudget,
  resolveRagConnection,
  warmOllamaModel,
  type RagConnection,
} from '@haive/shared/rag';
import {
  secretMaskDeniesPath,
  secretMaskPolicy,
  type SecretMaskPolicy,
} from '../src/queues/cli-exec/secret-mask-policy.js';
import { listTrackedFiles } from '../src/queues/cli-exec/secret-mask.js';
import { listFilesMatching } from '../src/step-engine/steps/onboarding/_helpers.js';
import { collectCodeFiles } from '../src/step-engine/steps/onboarding/_rag-collect.js';
import {
  capChunks,
  chunkSection,
  contextHeader,
  fileBudget,
  extractCodeSections,
  extractMarkdownSections,
  type RagChunk,
} from '../src/step-engine/steps/onboarding/_rag-chunkers.js';
import {
  ensureRagSchema,
  isRagDatabaseClaimed,
  RAG_TABLE,
} from '../src/step-engine/steps/onboarding/_rag-connection.js';
import {
  chunkKey,
  computeStaleKeys,
  insertChunk,
} from '../src/step-engine/steps/onboarding/10-rag-populate.js';

const REFUSED_STORE_NAMES = ['elmont_rs', 'rs_final', 'kb_global'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROGRESS_EVERY_BATCHES = 50;
const META_TABLE = 'rag_build_store_meta';

type SourceType = 'kb' | 'code';

export class StoreRefusedError extends Error {}

export function storeDatabaseName(store: string): string {
  if (store.trim() === '') throw new StoreRefusedError('RAG_STORE is empty');
  const dbName = ragDatabaseName(store);
  for (const refused of REFUSED_STORE_NAMES) {
    if (dbName === ragDatabaseName(refused)) {
      throw new StoreRefusedError(`store ${refused} (database ${dbName}) is a live store`);
    }
  }
  return dbName;
}

export function assertNotLiveRepository(
  realRepositoryIds: ReadonlySet<string>,
  repositoryId: string,
  storeRepositoryIds: Iterable<string>,
): void {
  const real = new Set([...realRepositoryIds].map((id) => id.toLowerCase()));
  if (real.has(repositoryId.toLowerCase())) {
    throw new StoreRefusedError(`repository ${repositoryId} is a row of repositories: a live id`);
  }
  for (const id of storeRepositoryIds) {
    if (real.has(id.toLowerCase())) {
      throw new StoreRefusedError(
        `the store holds rows of repository ${id}, a row of repositories`,
      );
    }
  }
}

export interface BuildMeta {
  model: string;
  dims: number;
}

export async function readBuildMeta(pg: RagConnection['pg']): Promise<BuildMeta | null> {
  const present = (await pg.unsafe(`SELECT to_regclass($1) AS rel`, [
    META_TABLE,
  ])) as unknown as Array<{ rel: string | null }>;
  if (!present[0]?.rel) return null;
  const meta = (await pg.unsafe(
    `SELECT model, dims FROM ${META_TABLE} LIMIT 1`,
  )) as unknown as Array<BuildMeta>;
  return meta[0] ? { model: meta[0].model, dims: Number(meta[0].dims) } : null;
}

export type BuildMetaDecision =
  { action: 'record' | 'resume' } | { action: 'refuse'; reason: string };

export function decideBuildMeta(
  recorded: BuildMeta | null,
  storeHasRows: boolean,
  requested: BuildMeta,
): BuildMetaDecision {
  if (!recorded) {
    return storeHasRows
      ? {
          action: 'refuse',
          reason: `the store holds rows but no ${META_TABLE} row, so its embedding model is unknown: use a fresh store`,
        }
      : { action: 'record' };
  }
  if (recorded.model !== requested.model || recorded.dims !== requested.dims) {
    return {
      action: 'refuse',
      reason: `the store was built with model ${recorded.model} (${recorded.dims} dims), this run asks for model ${requested.model} (${requested.dims} dims)`,
    };
  }
  return { action: 'resume' };
}

export function validateEmbeddings(
  embeddings: unknown,
  expectedCount: number,
  dimensions: number,
): number[][] {
  if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) {
    throw new Error(
      `embed returned ${Array.isArray(embeddings) ? embeddings.length : 'no'} vectors for ${expectedCount} inputs`,
    );
  }
  for (const [i, vec] of embeddings.entries()) {
    if (!Array.isArray(vec) || vec.length !== dimensions) {
      throw new Error(
        `vector ${i} has ${Array.isArray(vec) ? vec.length : 'no'} dimensions, expected ${dimensions}`,
      );
    }
    if (!vec.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`vector ${i} holds a non-finite value`);
    }
  }
  return embeddings as number[][];
}

interface Options {
  tree: string;
  exclude: string[];
  heuristicExclude: string[];
  extensionSet?: string[];
  selectedDirs?: string[];
  ownPaths: string[];
  store: string | null;
  repositoryId: string | null;
  sourceRepositoryId: string | null;
  taskId: string;
  ollamaUrl: string;
  model: string;
  dims: number;
  dryRun: boolean;
  limitFiles: number | null;
}

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

export function stringArrayEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
    fail(`${name} must be a JSON array of strings`);
  }
  return parsed;
}

function parseOptions(): Options {
  const tree = process.env.RAG_TREE;
  if (!tree) fail('RAG_TREE is required');
  const scope = stringArrayEnv('RAG_EXCLUDE');
  const heuristic = stringArrayEnv('RAG_HEURISTIC_EXCLUDE');
  if (scope !== undefined && heuristic !== undefined) {
    fail(
      'set RAG_EXCLUDE or RAG_HEURISTIC_EXCLUDE, not both: a saved scope switches the heuristic off',
    );
  }
  const exclude = scope ?? [];
  const heuristicExclude = heuristic ?? [];
  const extensionSet = stringArrayEnv('RAG_EXTENSION_SET');
  const selectedDirs = stringArrayEnv('RAG_SELECTED_DIRS');
  const ownPaths = stringArrayEnv('RAG_OWN_PATHS') ?? [];
  const dims = Number(process.env.RAG_DIMS || 2560);
  if (!Number.isInteger(dims) || dims <= 0) fail('RAG_DIMS must be a positive integer');
  const limitRaw = process.env.RAG_LIMIT_FILES;
  const limitFiles = limitRaw ? Number(limitRaw) : null;
  if (limitFiles !== null && (!Number.isInteger(limitFiles) || limitFiles <= 0)) {
    fail('RAG_LIMIT_FILES must be a positive integer');
  }
  const dryRun = process.env.RAG_DRY_RUN === '1';
  const store = process.env.RAG_STORE || null;
  const repositoryId = process.env.RAG_REPOSITORY_ID || null;
  const sourceRepositoryId = process.env.RAG_SOURCE_REPOSITORY_ID || null;
  if (sourceRepositoryId && !UUID_PATTERN.test(sourceRepositoryId)) {
    fail('RAG_SOURCE_REPOSITORY_ID must be a uuid');
  }
  const taskId = process.env.RAG_TASK_ID || randomUUID();
  if (!dryRun) {
    if (!store) fail('RAG_STORE is required');
    if (!repositoryId || !UUID_PATTERN.test(repositoryId)) {
      fail('RAG_REPOSITORY_ID must be a uuid');
    }
    if (!UUID_PATTERN.test(taskId)) fail('RAG_TASK_ID must be a uuid');
  }
  return {
    tree,
    exclude,
    heuristicExclude,
    extensionSet,
    selectedDirs,
    ownPaths,
    store,
    repositoryId,
    sourceRepositoryId,
    taskId,
    ollamaUrl: process.env.RAG_OLLAMA_URL || 'http://ollama:11434',
    model: process.env.RAG_MODEL || 'qwen3-embedding:4b',
    dims,
    dryRun,
    limitFiles,
  };
}

async function collectKbFiles(tree: string): Promise<string[]> {
  const rels = await listFilesMatching(
    tree,
    (rel, isDir) => !isDir && rel.endsWith('.md') && rel.startsWith(`${KB_DIR}/`),
    5,
  );
  return rels.sort((a, b) => a.localeCompare(b));
}

async function collectCodeFilesSorted(opts: Options): Promise<string[]> {
  const rels = await collectCodeFiles(opts.tree, {
    exclude: opts.exclude,
    heuristicExclude: opts.heuristicExclude,
    ownPaths: opts.ownPaths,
    extensionSet: opts.extensionSet,
    selectedDirs: opts.selectedDirs,
  });
  return rels.sort((a, b) => a.localeCompare(b));
}

export function dropMaskedPaths(
  policy: SecretMaskPolicy,
  rels: string[],
): { kept: string[]; masked: string[] } {
  const kept: string[] = [];
  const masked: string[] = [];
  for (const rel of rels) (secretMaskDeniesPath(policy, rel) ? masked : kept).push(rel);
  return { kept, masked };
}

export function staleChunks(
  existingKeys: Iterable<string>,
  produced: ReadonlySet<string>,
): Array<{ sourcePath: string; sectionId: string; chunkIndex: number }> {
  return computeStaleKeys(existingKeys, produced).map((key) => {
    const [sourcePath, sectionId, chunkIndex] = JSON.parse(key) as [string, string, number];
    return { sourcePath, sectionId, chunkIndex };
  });
}

async function resolveMaskPolicy(
  opts: Options,
  db: ReturnType<typeof createDatabase> | null,
): Promise<SecretMaskPolicy> {
  const tracked = await listTrackedFiles(opts.tree);
  if (!opts.sourceRepositoryId) return secretMaskPolicy({ tracked });
  const [row] = await db!
    .select({
      allow: schema.repositories.secretMaskAllow,
      denyExtend: schema.repositories.secretMaskDenyExtend,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, opts.sourceRepositoryId))
    .limit(1);
  if (!row) fail(`refused: repository ${opts.sourceRepositoryId} not found`, 2);
  return secretMaskPolicy({ allow: row.allow, denyExtend: row.denyExtend, tracked });
}

interface FileChunks {
  kind: SourceType;
  relPath: string;
  chunks: RagChunk[];
  dropped: number;
}

interface Tally {
  files: Record<SourceType, number>;
  chunks: Record<SourceType, number>;
  dropped: number;
  filesCapped: number;
  unreadable: number;
  oversize: number;
}

async function chunkFile(
  tree: string,
  kind: SourceType,
  relPath: string,
  ownPaths: readonly string[],
  tally: Tally,
): Promise<FileChunks | null> {
  let text: string | null;
  try {
    text = await readTextNoFollow(tree, relPath);
  } catch {
    text = null;
  }
  if (text === null) {
    tally.unreadable += 1;
    return null;
  }
  const budget = fileBudget(relPath, kind, ownPaths);
  if (Buffer.byteLength(text, 'utf8') > budget.maxBytes) {
    tally.oversize += 1;
    return null;
  }
  const sections =
    kind === 'kb' ? extractMarkdownSections(text, relPath) : extractCodeSections(text, relPath);
  const built: RagChunk[] = [];
  for (const section of sections) {
    built.push(...chunkSection(section, { header: contextHeader(relPath, section.breadcrumb) }));
  }
  const { chunks, dropped } = capChunks(built, budget.maxChunks);
  if (dropped > 0) {
    tally.dropped += dropped;
    tally.filesCapped += 1;
  }
  if (chunks.length === 0) return null;
  tally.files[kind] += 1;
  tally.chunks[kind] += chunks.length;
  return { kind, relPath, chunks, dropped };
}

async function* chunkAll(
  tree: string,
  kbFiles: string[],
  codeFiles: string[],
  ownPaths: readonly string[],
  tally: Tally,
): AsyncGenerator<FileChunks> {
  for (const relPath of kbFiles) {
    const file = await chunkFile(tree, 'kb', relPath, ownPaths, tally);
    if (file) yield file;
  }
  for (const relPath of codeFiles) {
    const file = await chunkFile(tree, 'code', relPath, ownPaths, tally);
    if (file) yield file;
  }
}

function newTally(): Tally {
  return {
    files: { kb: 0, code: 0 },
    chunks: { kb: 0, code: 0 },
    dropped: 0,
    filesCapped: 0,
    unreadable: 0,
    oversize: 0,
  };
}

function printTally(tally: Tally): void {
  console.log(`kb files:     ${tally.files.kb}`);
  console.log(`code files:   ${tally.files.code}`);
  console.log(`kb chunks:    ${tally.chunks.kb}`);
  console.log(`code chunks:  ${tally.chunks.code}`);
  console.log(`total chunks: ${tally.chunks.kb + tally.chunks.code}`);
  console.log(`dropped by cap: ${tally.dropped} chunks in ${tally.filesCapped} files`);
  console.log(`unreadable files: ${tally.unreadable}, over the size limit: ${tally.oversize}`);
}

async function realRepositoryIds(
  db: ReturnType<typeof createDatabase>,
  candidates: string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.repositories.id })
    .from(schema.repositories)
    .where(inArray(schema.repositories.id, candidates));
  return new Set(rows.map((r) => r.id));
}

async function preflightStore(
  opts: Options,
  db: ReturnType<typeof createDatabase>,
  dbName: string,
): Promise<'record' | 'resume'> {
  const repositoryId = opts.repositoryId!;
  assertNotLiveRepository(await realRepositoryIds(db, [repositoryId]), repositoryId, []);
  if (await isRagDatabaseClaimed(db, dbName)) {
    throw new StoreRefusedError(`database ${dbName} is a repository's RAG store`);
  }
  const existing = await openExistingRagDatabase(db, dbName, opts.dims);
  if (!existing) return 'record';
  let storeIds: string[] = [];
  let storeHasRows = false;
  let recorded: BuildMeta | null = null;
  try {
    const present = (await existing.pg.unsafe(`SELECT to_regclass($1) AS rel`, [
      RAG_TABLE,
    ])) as unknown as Array<{ rel: string | null }>;
    if (present[0]?.rel) {
      const foreign = (await existing.pg.unsafe(
        `SELECT count(*)::int AS n FROM ${RAG_TABLE} WHERE repository_id IS DISTINCT FROM $1`,
        [repositoryId],
      )) as unknown as Array<{ n: number }>;
      if (foreign[0]!.n > 0) {
        throw new StoreRefusedError(
          `database ${dbName} already holds ${foreign[0]!.n} rows with a repository_id other than ${repositoryId}`,
        );
      }
      const ids = (await existing.pg.unsafe(
        `SELECT DISTINCT repository_id::text AS id FROM ${RAG_TABLE} WHERE repository_id IS NOT NULL`,
      )) as unknown as Array<{ id: string }>;
      storeIds = ids.map((r) => r.id);
      const total = (await existing.pg.unsafe(
        `SELECT count(*)::int AS n FROM ${RAG_TABLE}`,
      )) as unknown as Array<{ n: number }>;
      storeHasRows = total[0]!.n > 0;
    }
    recorded = await readBuildMeta(existing.pg);
  } finally {
    await existing.close();
  }
  assertNotLiveRepository(await realRepositoryIds(db, storeIds), repositoryId, storeIds);
  const decision = decideBuildMeta(recorded, storeHasRows, { model: opts.model, dims: opts.dims });
  if (decision.action === 'refuse') throw new StoreRefusedError(decision.reason);
  return decision.action;
}

async function recordBuildMeta(conn: RagConnection, opts: Options): Promise<void> {
  await conn.pg.unsafe(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (model text NOT NULL, dims int NOT NULL)`,
  );
  await conn.pg.unsafe(
    `INSERT INTO ${META_TABLE} (model, dims) SELECT $1::text, $2::int WHERE NOT EXISTS (SELECT 1 FROM ${META_TABLE})`,
    [opts.model, opts.dims],
  );
}

async function loadExistingHashes(
  conn: RagConnection,
  repositoryId: string,
): Promise<Map<string, string | null>> {
  const rows = (await conn.pg.unsafe(
    `SELECT source_path, section_id, chunk_index, chunk_hash FROM ${RAG_TABLE} WHERE repository_id = $1`,
    [repositoryId],
  )) as unknown as Array<{
    source_path: string;
    section_id: string;
    chunk_index: number;
    chunk_hash: string | null;
  }>;
  return new Map(
    rows.map((r) => [chunkKey(r.source_path, r.section_id, r.chunk_index), r.chunk_hash]),
  );
}

async function build(
  opts: Options,
  conn: RagConnection,
  kbFiles: string[],
  codeFiles: string[],
  metaAction: 'record' | 'resume',
): Promise<void> {
  const repositoryId = opts.repositoryId!;
  const started = Date.now();
  const { usedPgvector } = await ensureRagSchema(conn);
  if (!usedPgvector) throw new Error('pgvector is unavailable: refusing to write jsonb embeddings');
  if (metaAction === 'record') await recordBuildMeta(conn, opts);
  const existing = await loadExistingHashes(conn, repositoryId);
  console.log(`store holds ${existing.size} rows for ${repositoryId} before this run`);
  const produced = new Set<string>();

  const warmed = await warmOllamaModel(opts.ollamaUrl, opts.model);
  if (!warmed) console.warn(`warning: ${opts.model} at ${opts.ollamaUrl} did not warm`);
  const { embedTimeoutMs } = await resolveEmbedBudget();

  const tally = newTally();
  let inserted = 0;
  let skipped = 0;
  let batches = 0;
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

  for await (const file of chunkAll(opts.tree, kbFiles, codeFiles, opts.ownPaths, tally)) {
    const toEmbed: RagChunk[] = [];
    for (const chunk of file.chunks) {
      const key = chunkKey(file.relPath, chunk.sectionId, chunk.chunkIndex);
      produced.add(key);
      if (existing.get(key) === chunk.chunkHash) skipped += 1;
      else toEmbed.push(chunk);
    }
    for (let start = 0; start < toEmbed.length; start += EMBED_BATCH_SIZE) {
      const batch = toEmbed.slice(start, start + EMBED_BATCH_SIZE);
      let embeddings: number[][];
      try {
        embeddings = validateEmbeddings(
          await ollamaEmbed(
            opts.ollamaUrl,
            opts.model,
            batch.map((c) => c.content),
            { timeoutMs: embedTimeoutMs },
          ),
          batch.length,
          opts.dims,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`embed failed for ${file.relPath} (batch at chunk ${start}): ${reason}`, {
          cause: err,
        });
      }
      for (const [i, chunk] of batch.entries()) {
        await insertChunk(
          conn,
          true,
          opts.taskId,
          repositoryId,
          file.kind,
          file.relPath,
          chunk.sectionId,
          chunk.chunkIndex,
          chunk.chunkHash,
          chunk.content,
          embeddings[i]!,
          true,
        );
        inserted += 1;
      }
      batches += 1;
      if (batches % PROGRESS_EVERY_BATCHES === 0) {
        console.log(
          `batch ${batches}: inserted ${inserted}, skipped ${skipped}, at ${file.relPath} (${elapsed()})`,
        );
      }
    }
  }

  const stale = staleChunks(existing.keys(), produced);
  let purged = 0;
  const PURGE_BATCH = 200;
  for (let i = 0; i < stale.length; i += PURGE_BATCH) {
    const batch = stale.slice(i, i + PURGE_BATCH);
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
    purged += typeof res?.count === 'number' ? res.count : batch.length;
  }
  console.log(`purged: ${purged} stale rows`);

  console.log(
    `done: inserted ${inserted}, skipped ${skipped}, files ${tally.files.kb + tally.files.code} ` +
      `(${tally.files.kb} kb, ${tally.files.code} code), elapsed ${elapsed()}`,
  );
}

async function main(): Promise<void> {
  const opts = parseOptions();
  let dbName: string | null = null;
  if (!opts.dryRun) {
    try {
      dbName = storeDatabaseName(opts.store!);
    } catch (err) {
      if (err instanceof StoreRefusedError) fail(`refused: ${err.message}`, 2);
      throw err;
    }
  }

  if ((!opts.dryRun || opts.sourceRepositoryId) && !process.env.DATABASE_URL) {
    fail('DATABASE_URL is required');
  }
  const db =
    !opts.dryRun || opts.sourceRepositoryId ? createDatabase(process.env.DATABASE_URL!) : null;
  const policy = await resolveMaskPolicy(opts, db);
  const keptKb = dropMaskedPaths(policy, await collectKbFiles(opts.tree));
  const keptCode = dropMaskedPaths(policy, await collectCodeFilesSorted(opts));
  const kbFiles = keptKb.kept;
  const allCode = keptCode.kept;
  console.log(`masked: ${keptKb.masked.length + keptCode.masked.length} files`);
  const codeFiles = opts.limitFiles === null ? allCode : allCode.slice(0, opts.limitFiles);
  console.log(`tree ${opts.tree}`);
  console.log(
    `candidates: ${kbFiles.length} kb files, ${codeFiles.length} of ${allCode.length} code files`,
  );

  if (opts.dryRun) {
    const tally = newTally();
    for await (const file of chunkAll(opts.tree, kbFiles, codeFiles, opts.ownPaths, tally))
      void file;
    printTally(tally);
    process.exit(0);
  }

  let metaAction: 'record' | 'resume';
  try {
    metaAction = await preflightStore(opts, db!, dbName!);
  } catch (err) {
    if (err instanceof StoreRefusedError) fail(`refused: ${err.message}`, 2);
    throw err;
  }

  console.log(`store ${dbName}, repository ${opts.repositoryId}, task ${opts.taskId}`);
  const conn = await resolveRagConnection(
    {
      ragMode: 'internal',
      ragConnectionString: null,
      ollamaUrl: opts.ollamaUrl,
      embeddingModel: opts.model,
      embeddingDimensions: opts.dims,
    },
    db!,
    opts.store!,
  );
  if (!conn) fail('could not open the store');
  try {
    await build(opts, conn, kbFiles, codeFiles, metaAction);
  } finally {
    await conn.close();
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
