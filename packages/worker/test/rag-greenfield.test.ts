import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@haive/database';
import { IN_STACK_OLLAMA_URL } from '@haive/shared';
import {
  repoRagIdentityFromMirror,
  resolveTaskStackContext,
  stackProjectName,
} from '@haive/shared/global-kb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  ensure: vi.fn(async () => ({ usedPgvector: false, tableName: 'ai_rag_embeddings' })),
  probe: vi.fn(async () => true),
  embed:
    vi.fn<
      (
        opts: import('../src/step-engine/steps/_rag-embed-health.js').EmbedBatchOpts,
      ) => Promise<import('../src/step-engine/steps/_rag-embed-health.js').EmbedBatchOutcome>
    >(),
  close: vi.fn(async () => {}),
}));
vi.mock('../src/step-engine/steps/onboarding/_rag-connection.js', async (original) => ({
  ...(await original<object>()),
  resolveRagConnection: mocks.connect,
  ensureRagSchema: mocks.ensure,
}));
vi.mock('../src/step-engine/steps/onboarding/_rag-embed.js', async (original) => ({
  ...(await original<object>()),
  probeOllama: mocks.probe,
  warmOllamaModel: async () => false,
}));
vi.mock('../src/step-engine/steps/_rag-embed-health.js', async (original) => ({
  ...(await original<object>()),
  embedBatch: mocks.embed,
  resolveEmbedBatchSize: async () => 8,
}));

const { ragReindexStep } = await import('../src/step-engine/steps/workflow/11c-rag-reindex.js');
const { workflowRagSourceSelectionStep } =
  await import('../src/step-engine/steps/workflow/11b1-rag-source-selection.js');
const { preRagSyncStep } = await import('../src/step-engine/steps/workflow/02-pre-rag-sync.js');
const { collectDefaults, readComposerJson, readGitignore } =
  await import('../src/step-engine/steps/onboarding/_scope.js');
const { workspaceAnchor } = await import('../src/repo/worktree-paths.js');
const { resolveRagSyncPrefs, runRagIndexSync } =
  await import('../src/step-engine/steps/workflow/_rag-index.js');

const dialect = new PgDialect();
let root: string;
let worktree: string;
let repo: Record<string, unknown>;
let onboarding: { id: string } | null;
let writes: Record<string, unknown>[];
let warnings: Array<string | null>;
let inserts: unknown[][];
let stalePaths: string[];
let deletedPaths: string[];
let indexedChunks: Map<
  string,
  { section_id: string; chunk_index: number; chunk_hash: string | null; content: string }[]
>;
let ctx: StepContext;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.probe.mockResolvedValue(true);
  mocks.embed.mockImplementation(async ({ texts }) => ({
    kind: 'embedded',
    embeddings: texts.map(() => [0.1, 0.2]),
  }));
  root = await mkdtemp(join(tmpdir(), 'haive-rag-greenfield-'));
  worktree = join(root, '.haive/worktrees/task');
  await mkdir(join(worktree, '.haive-data/knowledge_base'), { recursive: true });
  await writeFile(
    join(worktree, '.haive-data/knowledge_base/architecture.md'),
    '# Architecture\n\nThe app stores its documents in PostgreSQL.\n',
  );
  await writeFile(join(worktree, 'app.ts'), 'export function greeting() { return "hello"; }\n');
  repo = {
    source: 'blank',
    name: 'new-app',
    onboardingResetAt: null,
    scopeExcludeGlobs: [],
    onboardingTooling: null,
    onboardingEnvironment: null,
    ragEmbedDegradedAt: null,
    ragEmbedDegradedReason: null,
    ragEmbedLexicalOnly: false,
  };
  onboarding = null;
  writes = [];
  warnings = [];
  inserts = [];
  stalePaths = [];
  deletedPaths = [];
  indexedChunks = new Map();
  mocks.connect.mockImplementation(async () => ({
    close: mocks.close,
    pg: {
      unsafe: async (query: string, params: unknown[] = []) => {
        if (query.includes('INSERT INTO')) {
          inserts.push(params);
          const rows = indexedChunks.get(params[3] as string) ?? [];
          const row = {
            section_id: params[4] as string,
            chunk_index: params[5] as number,
            chunk_hash: params[6] as string,
            content: params[7] as string,
          };
          const idx = rows.findIndex(
            (r) => r.section_id === row.section_id && r.chunk_index === row.chunk_index,
          );
          if (idx >= 0) rows[idx] = row;
          else rows.push(row);
          indexedChunks.set(params[3] as string, rows);
        }
        if (query.includes('SELECT section_id, chunk_index, chunk_hash'))
          return indexedChunks.get(params[1] as string) ?? [];
        if (query.includes('UPDATE') && query.includes('SET chunk_hash = NULL')) {
          let count = 0;
          for (const rows of indexedChunks.values())
            for (const row of rows) {
              if (row.chunk_hash !== null) {
                row.chunk_hash = null;
                count += 1;
              }
            }
          return Object.assign([], { count });
        }
        if (query.includes('SELECT DISTINCT source_path'))
          return [...new Set([...stalePaths, ...indexedChunks.keys()])].map((source_path) => ({
            source_path,
          }));
        if (
          query.startsWith('DELETE FROM') &&
          query.includes('WHERE repository_id = $1 AND source_path = $2')
        ) {
          deletedPaths.push(params[1] as string);
          const path = params[1] as string;
          const rows = indexedChunks.get(path) ?? [];
          const kept = query.includes('AND section_id = $3')
            ? rows.filter((row) => row.section_id !== params[2] || row.chunk_index !== params[3])
            : [];
          indexedChunks.set(path, kept);
          return Object.assign([], { count: rows.length - kept.length });
        }
        return Object.assign([], { count: 0 });
      },
    },
  }));
  const db = {
    query: {
      tasks: {
        findFirst: async ({ where }: { where: never }) => {
          const query = dialect.sqlToQuery(where);
          return query.params.includes('onboarding') ? onboarding : { repositoryId: 'repo-1' };
        },
      },
      repositories: { findFirst: async () => repo },
      taskSteps: {
        findFirst: async ({ where }: { where: never }) => {
          const query = dialect.sqlToQuery(where);
          if (query.params.includes('01-worktree-setup'))
            return { output: { worktreePath: worktree } };
          return undefined;
        },
      },
    },
    // Scope and plan-link queries have no rows for this new repository.
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => [{ globs: repo.scopeExcludeGlobs }] }),
        }),
        where: (condition: never) => ({
          limit: async () => (table === schema.tasks ? [{ repositoryId: 'repo-1' }] : []),
          orderBy: () => ({
            limit: async () => {
              const query = dialect.sqlToQuery(condition);
              return table === schema.taskSteps && query.params.includes('01-worktree-setup')
                ? [{ output: { worktreePath: worktree } }]
                : [];
            },
          }),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (condition: never) => {
          if (table === schema.taskSteps && 'warningMessage' in values)
            warnings.push(values.warningMessage as string | null);
          if (table !== schema.repositories) return [];
          if ('scopeExcludeGlobs' in values || 'ragEmbedDegradedAt' in values) {
            writes.push(values);
            Object.assign(repo, values);
            return [];
          }
          const query = dialect.sqlToQuery(condition);
          expect(query.sql).toContain('"onboarding_tooling" is null');
          expect(query.sql).toContain('"onboarding_environment" is null');
          expect(query.sql).toContain('"onboarding_reset_at" is null');
          expect(query.sql).toContain('NOT EXISTS');
          if (
            repo.source !== 'blank' ||
            repo.onboardingTooling ||
            repo.onboardingEnvironment ||
            repo.onboardingResetAt ||
            onboarding
          )
            return [];
          writes.push(values);
          Object.assign(repo, values);
          return [];
        },
      }),
    }),
  };
  ctx = {
    db,
    taskId: 'task-1',
    taskStepId: 'step-1',
    repoPath: root,
    workspacePath: root,
    emitProgress: async () => {},
    throwIfCancelled: () => {},
    logger: { info: () => {}, warn: () => {} },
  } as unknown as StepContext;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('greenfield RAG initialization at 11c', () => {
  it('offers initialization and counts the worktree knowledge without writing during detect', async () => {
    expect((await resolveRagSyncPrefs(ctx)).ragConfigured).toBe(false);
    const detected = await ragReindexStep.detect!(ctx);
    expect(detected).toMatchObject({
      ragConfigured: true,
      needsInitialization: true,
      projectName: 'new-app',
      kbFileCount: 1,
      codeFileCount: 1,
      ragToolingPrefs: {
        ragMode: 'internal',
        ollamaUrl: IN_STACK_OLLAMA_URL,
        embeddingModel: 'qwen3-embedding:4b',
        embeddingDimensions: 2560,
      },
    });
    const form = await ragReindexStep.form!(ctx, detected);
    expect(form?.fields[0]).toMatchObject({ id: 'runReindex', default: true });
    expect(form?.description).toContain('initialize');
    expect(writes).toEqual([]);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('initializes, ingests real worktree KB and code, and gives retrieval and later sync the same identity', async () => {
    const detected = await ragReindexStep.detect!(ctx);
    const result = await ragReindexStep.apply(ctx, {
      detected,
      formValues: { runReindex: true },
      iteration: 0,
      previousIterations: [],
    });
    expect(result.performed).toBe(true);
    expect(result.inserted).toBeGreaterThanOrEqual(2);
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['kb', '.haive-data/knowledge_base/architecture.md']),
        expect.arrayContaining(['code', 'app.ts']),
      ]),
    );
    expect(writes).toHaveLength(1);
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    const search = await resolveTaskStackContext(ctx.db, 'later-task');
    const sync = await resolveRagSyncPrefs(ctx);
    expect(search.tooling).toMatchObject(sync.ragToolingPrefs!);
    expect(stackProjectName(search)).toBe(sync.projectName);
    expect(sync.needsInitialization).toBe(false);
    expect(repoRagIdentityFromMirror(repo.onboardingTooling, repo.onboardingEnvironment)).toEqual({
      projectName: 'new-app',
      ragMode: 'internal',
    });
  });

  it('keeps initial chunks unindexed during an Ollama outage and indexes them on recovery', async () => {
    mocks.probe.mockResolvedValue(false);
    mocks.embed.mockResolvedValue({ kind: 'failed', reason: 'Ollama is unreachable' });
    const detected = await ragReindexStep.detect!(ctx);
    const first = await ragReindexStep.apply(ctx, {
      detected,
      formValues: { runReindex: true },
      iteration: 0,
      previousIterations: [],
    });
    expect(first).toMatchObject({
      performed: true,
      inserted: 0,
      embedFailureReason: 'Ollama is unreachable',
    });
    expect(first.embedSkippedChunks).toBeGreaterThan(0);
    expect(inserts).toEqual([]);
    expect(mocks.embed.mock.calls.every(([opts]) => opts.useOllama)).toBe(true);
    expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
    const saved = await resolveRagSyncPrefs(ctx);
    expect(saved.ollamaUrlDerived).toBe(false);
    expect(saved.ragToolingPrefs?.ollamaUrl).toBe(IN_STACK_OLLAMA_URL);

    mocks.probe.mockResolvedValue(true);
    mocks.embed.mockImplementation(async ({ texts }) => ({
      kind: 'embedded',
      embeddings: texts.map(() => [0.1, 0.2]),
    }));
    const recovered = await ragReindexStep.apply(ctx, {
      detected: await ragReindexStep.detect!(ctx),
      formValues: { runReindex: true },
      iteration: 0,
      previousIterations: [],
    });
    expect(recovered.inserted).toBeGreaterThanOrEqual(2);
    expect(recovered.embedSkippedChunks).toBe(0);
    expect(repo.ragEmbedDegradedAt).toBeNull();
  });

  it.each([false, true])(
    'retains existing chunks through an outage (derived endpoint: %s)',
    async (derived) => {
      await ragReindexStep.apply(ctx, {
        detected: await ragReindexStep.detect!(ctx),
        formValues: { runReindex: true },
        iteration: 0,
        previousIterations: [],
      });
      const kbPath = '.haive-data/knowledge_base/architecture.md';
      const previous = { ...indexedChunks.get(kbPath)![0]! };
      if (derived) {
        const mirror = repo.onboardingTooling as { tooling: Record<string, unknown> };
        delete mirror.tooling.ollamaUrl;
      } else {
        await writeSource(
          kbPath,
          '# Architecture\n\nThe app now stores documents in a new database.\n',
        );
      }
      inserts = [];
      deletedPaths = [];
      mocks.probe.mockResolvedValue(false);
      mocks.embed.mockResolvedValue({ kind: 'failed', reason: 'Ollama is unreachable' });
      const failed = await ragReindexStep.apply(ctx, {
        detected: await ragReindexStep.detect!(ctx),
        formValues: { runReindex: true },
        iteration: 0,
        previousIterations: [],
      });
      expect(failed).toMatchObject({
        inserted: 0,
        updated: 0,
        embedFailureReason: 'Ollama is unreachable',
      });
      expect(failed.embedSkippedChunks).toBeGreaterThan(0);
      expect(inserts).toEqual([]);
      expect(deletedPaths).toEqual([]);
      expect(indexedChunks.get(kbPath)![0]).toMatchObject({
        content: previous.content,
        chunk_hash: derived ? null : previous.chunk_hash,
      });

      mocks.probe.mockResolvedValue(true);
      mocks.embed.mockImplementation(async ({ texts }) => ({
        kind: 'embedded',
        embeddings: texts.map(() => [0.1, 0.2]),
      }));
      const recovered = await ragReindexStep.apply(ctx, {
        detected: await ragReindexStep.detect!(ctx),
        formValues: { runReindex: true },
        iteration: 0,
        previousIterations: [],
      });
      expect(recovered.updated).toBeGreaterThan(0);
      expect(recovered.embedSkippedChunks).toBe(0);
      expect(indexedChunks.get(kbPath)![0]!.chunk_hash).not.toBeNull();
      if (!derived) expect(indexedChunks.get(kbPath)![0]!.content).toContain('a new database');
      expect(deletedPaths).toEqual([]);
      expect(repo.ragEmbedDegradedAt).toBeNull();
    },
  );

  it.each(['failed', 'partial'])(
    'retains renamed section keys until all replacement batches succeed (%s outage)',
    async (outage) => {
      const sync = async () =>
        ragReindexStep.apply(ctx, {
          detected: await ragReindexStep.detect!(ctx),
          formValues: { runReindex: true },
          iteration: 0,
          previousIterations: [],
        });
      await sync();
      const kbPath = '.haive-data/knowledge_base/architecture.md';
      const previous = { ...indexedChunks.get(kbPath)![0]! };
      await writeSource(
        kbPath,
        Array.from(
          { length: 12 },
          (_, i) => `# Renamed section ${i}\n\nThe new architecture detail is number ${i}.\n`,
        ).join('\n'),
      );
      deletedPaths = [];
      mocks.embed.mockClear();
      if (outage === 'failed') {
        mocks.embed.mockResolvedValue({ kind: 'failed', reason: 'Ollama is unreachable' });
      } else {
        mocks.embed.mockResolvedValueOnce({ kind: 'failed', reason: 'Ollama timed out' });
      }
      const failed = await sync();
      expect(mocks.embed.mock.calls.length).toBeGreaterThan(1);
      expect(failed.embedSkippedChunks).toBeGreaterThan(0);
      expect(failed.deleted).toBe(0);
      expect(deletedPaths).toEqual([]);
      expect(indexedChunks.get(kbPath)).toContainEqual(previous);
      if (outage === 'partial') expect(failed.inserted).toBeGreaterThan(0);

      mocks.embed.mockImplementation(async ({ texts }) => ({
        kind: 'embedded',
        embeddings: texts.map(() => [0.1, 0.2]),
      }));
      const recovered = await sync();
      expect(recovered.embedSkippedChunks).toBe(0);
      expect(recovered.deleted).toBeGreaterThan(0);
      expect(deletedPaths).toContain(kbPath);
      expect(indexedChunks.get(kbPath)).not.toContainEqual(previous);
      expect(indexedChunks.get(kbPath)).toHaveLength(12);
      expect(repo.ragEmbedDegradedAt).toBeNull();
    },
  );

  it('removes deleted sections when unchanged replacements need no embedding', async () => {
    const kbPath = '.haive-data/knowledge_base/architecture.md';
    const retained = '# Architecture\n\nThe app stores its documents in PostgreSQL.\n';
    await writeSource(kbPath, `${retained}\n# Removed\n\nThis section will be removed.\n`);
    const sync = async () =>
      ragReindexStep.apply(ctx, {
        detected: await ragReindexStep.detect!(ctx),
        formValues: { runReindex: true },
        iteration: 0,
        previousIterations: [],
      });
    await sync();
    expect(indexedChunks.get(kbPath)).toHaveLength(2);
    await writeSource(kbPath, retained);
    mocks.embed.mockClear();
    mocks.embed.mockResolvedValue({ kind: 'failed', reason: 'Ollama is unreachable' });
    const result = await sync();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(result.deleted).toBe(1);
    expect(indexedChunks.get(kbPath)).toHaveLength(1);
    expect(indexedChunks.get(kbPath)![0]!.content).toContain('stores its documents');
  });

  it.each(['failed', 'partial'])(
    'retains moved-file rows until replacements succeed while removing excluded files (%s outage)',
    async (outage) => {
      const oldPath = '.haive-data/knowledge_base/architecture.md';
      const newPath = '.haive-data/knowledge_base/moved.md';
      await writeSource(
        oldPath,
        Array.from({ length: 12 }, (_, i) => `# Section ${i}\n\nArchitecture detail ${i}.\n`).join(
          '\n',
        ),
      );
      await writeSource('core/library.php');
      await writeSource('core/removed.php');
      const sync = async () =>
        ragReindexStep.apply(ctx, {
          detected: await ragReindexStep.detect!(ctx),
          formValues: { runReindex: true },
          iteration: 0,
          previousIterations: [],
        });
      await sync();
      const previous = indexedChunks.get(oldPath)!.map((row) => ({ ...row }));
      expect(previous).toHaveLength(12);
      expect(indexedChunks.get('core/library.php')!.length).toBeGreaterThan(0);
      await rename(join(worktree, oldPath), join(worktree, newPath));
      await rm(join(worktree, 'core/removed.php'));
      repo.scopeExcludeGlobs = ['core'];
      deletedPaths = [];
      mocks.embed.mockClear();
      if (outage === 'failed') {
        mocks.embed.mockResolvedValue({ kind: 'failed', reason: 'Ollama is unreachable' });
      } else {
        mocks.embed.mockResolvedValueOnce({ kind: 'failed', reason: 'Ollama timed out' });
      }
      const failed = await sync();
      expect(mocks.embed.mock.calls.length).toBeGreaterThan(1);
      expect(failed.embedSkippedChunks).toBeGreaterThan(0);
      expect(indexedChunks.get(oldPath)).toEqual(previous);
      expect(deletedPaths).not.toContain(oldPath);
      expect(indexedChunks.get('core/library.php')).toEqual([]);
      expect(deletedPaths).toContain('core/library.php');
      expect(indexedChunks.get('core/removed.php')).toEqual([]);
      expect(deletedPaths).toContain('core/removed.php');
      if (outage === 'partial') expect(failed.inserted).toBeGreaterThan(0);

      mocks.embed.mockImplementation(async ({ texts }) => ({
        kind: 'embedded',
        embeddings: texts.map(() => [0.1, 0.2]),
      }));
      const recovered = await sync();
      expect(recovered.embedSkippedChunks).toBe(0);
      expect(recovered.deleted).toBe(12);
      expect(indexedChunks.get(oldPath)).toEqual([]);
      expect(indexedChunks.get(newPath)).toHaveLength(12);
      expect(repo.ragEmbedDegradedAt).toBeNull();
    },
  );

  it('cleans up a deleted file when no replacement embedding fails', async () => {
    const sync = async () =>
      ragReindexStep.apply(ctx, {
        detected: await ragReindexStep.detect!(ctx),
        formValues: { runReindex: true },
        iteration: 0,
        previousIterations: [],
      });
    await sync();
    await rm(join(worktree, 'app.ts'));
    mocks.embed.mockClear();
    const result = await sync();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(result.deleted).toBeGreaterThan(0);
    expect(indexedChunks.get('app.ts')).toEqual([]);
  });

  it.each(['reverted', 'deleted', 'hashed'])(
    'retains degradation until a real health-check embedding succeeds (%s failed edit)',
    async (scenario) => {
      const kbPath = '.haive-data/knowledge_base/architecture.md';
      const original = '# Architecture\n\nThe app stores its documents in PostgreSQL.\n';
      const sync = async () =>
        ragReindexStep.apply(ctx, {
          detected: await ragReindexStep.detect!(ctx),
          formValues: { runReindex: true },
          iteration: 0,
          previousIterations: [],
        });
      await sync();
      await writeSource(kbPath, '# Architecture\n\nA failed update.\n');
      mocks.probe.mockResolvedValue(false);
      mocks.embed.mockResolvedValue({ kind: 'failed', reason: 'Ollama is unreachable' });
      await sync();
      expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
      if (scenario === 'deleted') await rm(join(worktree, kbPath));
      else await writeSource(kbPath, original);
      mocks.embed.mockClear();
      if (scenario === 'hashed')
        mocks.embed.mockResolvedValue({ kind: 'hashed', embeddings: [[0.1, 0.2]] });
      const stillDegraded = await sync();
      expect(stillDegraded).toMatchObject({ inserted: 0, updated: 0, embedSkippedChunks: 0 });
      expect(mocks.embed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ useOllama: true, texts: ['RAG embedding health check'] }),
      );
      expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
      expect(warnings.at(-1)).toContain('RAG embeddings are failing');

      mocks.embed.mockImplementation(async ({ texts }) => ({
        kind: 'embedded',
        embeddings: texts.map(() => [0.1, 0.2]),
      }));
      const recovered = await sync();
      expect(recovered).toMatchObject({ inserted: 0, updated: 0, embedFailureReason: null });
      expect(repo.ragEmbedDegradedAt).toBeNull();
      expect(warnings.at(-1)).toBeNull();
    },
  );

  it('does not initialize when the user declines', async () => {
    const detected = await ragReindexStep.detect!(ctx);
    expect(
      (
        await ragReindexStep.apply(ctx, {
          detected,
          formValues: { runReindex: false },
          iteration: 0,
          previousIterations: [],
        })
      ).performed,
    ).toBe(false);
    expect(writes).toEqual([]);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'onboarding', 'reset', 'imported', 'unsupported mirror'])(
    'does not offer initialization for %s repositories',
    async (kind) => {
      if (kind === 'disabled')
        repo.onboardingTooling = { schemaVersion: 1, tooling: { ragMode: 'none' } };
      if (kind === 'onboarding') onboarding = { id: 'onboarding-1' };
      if (kind === 'reset') repo.onboardingResetAt = new Date();
      if (kind === 'imported') repo.source = 'git_https';
      if (kind === 'unsupported mirror')
        repo.onboardingTooling = { schemaVersion: 99, tooling: { ragMode: 'internal' } };
      const detected = await ragReindexStep.detect!(ctx);
      expect(detected.ragConfigured).toBe(false);
      expect(detected.needsInitialization).toBe(false);
      expect(
        (
          await ragReindexStep.apply(ctx, {
            detected,
            formValues: { runReindex: true },
            iteration: 0,
            previousIterations: [],
          })
        ).performed,
      ).toBe(false);
      expect(mocks.connect).not.toHaveBeenCalled();
    },
  );

  it('respects RAG disabled while the initialization form was open', async () => {
    const detected = await ragReindexStep.detect!(ctx);
    repo.onboardingTooling = { schemaVersion: 1, tooling: { ragMode: 'none' } };
    const result = await ragReindexStep.apply(ctx, {
      detected,
      formValues: { runReindex: true },
      iteration: 0,
      previousIterations: [],
    });
    expect(result.performed).toBe(false);
    expect(writes).toEqual([]);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('keeps existing external settings saved while the initialization form was open', async () => {
    const detected = await ragReindexStep.detect!(ctx);
    repo.onboardingTooling = {
      schemaVersion: 1,
      tooling: {
        ragMode: 'external',
        ragConnectionString: 'postgres://external/rag',
        ollamaUrl: 'http://other:11434',
        embeddingModel: 'other',
        embeddingDimensions: 2,
      },
    };
    repo.onboardingEnvironment = {
      schemaVersion: 1,
      envDetectData: { project: { name: 'configured-app' } },
      confirmedValues: {},
    };
    const result = await ragReindexStep.apply(ctx, {
      detected,
      formValues: { runReindex: true },
      iteration: 0,
      previousIterations: [],
    });
    expect(result.performed).toBe(true);
    expect(writes).toEqual([]);
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ ragMode: 'external' }),
      ctx.db,
      'configured-app',
    );
    expect(mocks.probe).toHaveBeenLastCalledWith('http://other:11434');
  });
});

async function writeSource(
  rel: string,
  body = 'export function source() { return "project code"; }\n',
  base = worktree,
) {
  const target = join(base, rel);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, body);
}

async function saveScope(
  detected: import('../src/step-engine/steps/onboarding/09_7-rag-source-selection.js').RagSourceSelectionDetect,
  selectedDirs: string[],
) {
  return workflowRagSourceSelectionStep.apply(ctx, {
    detected,
    formValues: { selectedDirs },
    iteration: 0,
    previousIterations: [],
  });
}

describe('first workflow RAG source scope', () => {
  beforeEach(() => {
    repo.scopeExcludeGlobs = null;
  });

  it('asks once, including repositories initialized by the earlier fix, and keeps the pre-sync idle', async () => {
    expect(await workflowRagSourceSelectionStep.shouldRun!(ctx)).toBe(true);
    expect(await preRagSyncStep.shouldRun!(ctx)).toBe(false);
    repo.onboardingTooling = { schemaVersion: 1, tooling: { ragMode: 'internal' } };
    expect(await workflowRagSourceSelectionStep.shouldRun!(ctx)).toBe(true);
    repo.scopeExcludeGlobs = [];
    expect(await workflowRagSourceSelectionStep.shouldRun!(ctx)).toBe(false);
    expect(await preRagSyncStep.shouldRun!(ctx)).toBe(true);
  });

  it('does not ask when RAG is disabled or for an imported repo without configuration', async () => {
    repo.onboardingTooling = { schemaVersion: 1, tooling: { ragMode: 'none' } };
    expect(await workflowRagSourceSelectionStep.shouldRun!(ctx)).toBe(false);
    repo.onboardingTooling = null;
    repo.source = 'git_https';
    expect(await workflowRagSourceSelectionStep.shouldRun!(ctx)).toBe(false);
  });

  it.each(['.haive', '.haive/worktrees', '.haive/worktrees/task'])(
    'refuses a linked worktree component (%s) without exposing its target',
    async (linked) => {
      const outside = await mkdtemp(join(tmpdir(), 'haive-rag-foreign-'));
      try {
        const targetWorkspace = join(outside, '.haive/worktrees/task'.slice(linked.length + 1));
        await mkdir(join(targetWorkspace, 'private'), { recursive: true });
        await writeFile(join(targetWorkspace, 'private/secret.ts'), 'export const secret = true;');
        await writeFile(join(targetWorkspace, 'composer.json'), '{"name":"private/project"}');
        await writeFile(join(targetWorkspace, '.gitignore'), '/private/\n');
        await rm(join(root, linked), { recursive: true, force: true });
        await symlink(outside, join(root, linked));
        await expect(workflowRagSourceSelectionStep.detect!(ctx)).rejects.toThrow();
        expect(writes).toEqual([]);
        const wa = workspaceAnchor(worktree);
        expect(await readComposerJson(wa.anchor, wa.prefix)).toBeNull();
        expect(await readGitignore(wa.anchor, wa.prefix)).toBeNull();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('pre-excludes Drupal/Composer dependencies and generated folders from the worktree', async () => {
    await writeSource('web/core/lib/framework.php');
    await writeSource('web/modules/contrib/plugin/plugin.php');
    await writeSource('web/modules/custom/project/project.php');
    await writeSource('web/themes/custom/project/theme.php');
    await writeSource('third-party/library/library.php');
    await writeSource('generated/output.ts');
    await writeSource('.claude/hooks/hook.ts');
    await writeSource('node_modules/package/index.js');
    await writeSource('package.json', '{"scripts":{"build":"theme-build"}}');
    await writeSource(
      'composer.json',
      JSON.stringify({
        extra: {
          'installer-paths': {
            'web/core': ['type:drupal-core'],
            'web/modules/contrib/{$name}': ['type:drupal-module'],
            'third-party/library/{$name}': ['type:drupal-library'],
          },
        },
      }),
    );
    await writeSource('.gitignore', '/generated/\n');
    await writeSource('old-tree/only-in-root.ts', undefined, root);
    await writeSource('.gitignore', '/web/modules/custom/\n', root);
    await writeSource(
      'composer.json',
      '{"extra":{"installer-paths":{"web/modules/custom/{$name}":["type:drupal-module"]}}}',
      root,
    );
    const detected = await workflowRagSourceSelectionStep.detect!(ctx);
    expect(detected.framework).toBe('drupal');
    expect(detected.defaultExcludeGlobs).toEqual(
      expect.arrayContaining([
        'web/core',
        'web/modules/contrib',
        'third-party/library',
        'generated',
        '.claude',
        'node_modules',
      ]),
    );
    const form = workflowRagSourceSelectionStep.form!(ctx, detected);
    expect(form?.fields[0]).toMatchObject({ type: 'directory-tree', id: 'selectedDirs' });
    expect(form?.autoSubmit).not.toBe(true);
    expect(workflowRagSourceSelectionStep.metadata.autoSubmitDefaults).not.toBe(true);
    const defaults = collectDefaults(detected.tree, detected.defaultExcludeGlobs);
    expect(defaults).toContain('web/modules/custom/project');
    expect(defaults).not.toContain('web/core/lib');
    expect(defaults).not.toContain('old-tree');
    // Save exactly the user's defaults, including the repo-root file leaf.
    await saveScope(detected, defaults);
    const reindex = await ragReindexStep.detect!(ctx);
    expect(reindex.needsScopeSelection).toBe(false);
    const result = await ragReindexStep.apply(ctx, {
      detected: reindex,
      formValues: { runReindex: true },
      iteration: 0,
      previousIterations: [],
    });
    expect(result.performed).toBe(true);
    const indexedPaths = inserts.map((p) => p[3]);
    expect(indexedPaths).toContain('web/modules/custom/project/project.php');
    expect(indexedPaths).toContain('.haive-data/knowledge_base/architecture.md');
    expect(indexedPaths).not.toContain('web/core/lib/framework.php');
    expect(indexedPaths).not.toContain('web/modules/contrib/plugin/plugin.php');
    expect(indexedPaths).not.toContain('third-party/library/library.php');
    expect(await workflowRagSourceSelectionStep.shouldRun!(ctx)).toBe(false);
  });

  it('prefers a stronger root Laravel match over Node frontend tooling in web/', async () => {
    await writeSource('artisan', '<?php');
    await writeSource('composer.json', '{}');
    await writeSource('app/Service.php');
    await writeSource('routes/web.php');
    await writeSource('storage/logs/debug.php');
    await writeSource('bootstrap/cache/services.php');
    await writeSource('web/package.json', '{}');
    await writeSource('web/node_modules/frontend/index.js');
    const detected = await workflowRagSourceSelectionStep.detect!(ctx);
    expect(detected.framework).toBe('laravel');
    expect(detected.defaultExcludeGlobs).toEqual(
      expect.arrayContaining(['storage', 'bootstrap/cache']),
    );
    const defaults = collectDefaults(detected.tree, detected.defaultExcludeGlobs);
    expect(defaults).toContain('app');
    expect(defaults).toContain('routes');
    expect(defaults).not.toContain('storage/logs');
    expect(defaults).not.toContain('bootstrap/cache');
  });

  it('rebases framework exclusions for a Laravel project inside web/', async () => {
    await writeSource('web/artisan', '<?php');
    await writeSource('web/composer.json', '{}');
    await writeSource('web/app/Service.php');
    await writeSource('web/routes/web.php');
    await writeSource('web/storage/logs/debug.php');
    await writeSource('web/bootstrap/cache/services.php');
    await writeSource('web/.gitignore', '/storage/*.key\n/bootstrap/cache/*\n');
    const detected = await workflowRagSourceSelectionStep.detect!(ctx);
    expect(detected.framework).toBe('laravel');
    expect(detected.defaultExcludeGlobs).toEqual(
      expect.arrayContaining(['web/storage', 'web/bootstrap/cache']),
    );
    const defaults = collectDefaults(detected.tree, detected.defaultExcludeGlobs);
    expect(defaults).toContain('web/app');
    expect(defaults).not.toContain('web/storage/logs');
    expect(defaults).not.toContain('web/bootstrap/cache');
  });

  it.each(['root', 'worktree'])(
    'enforces the current saved scope when replaying an older sync form (%s scan)',
    async (scan) => {
      const kbPath = '.haive-data/knowledge_base/architecture.md';
      for (const base of [root, worktree]) {
        await writeSource(kbPath, '# Architecture\n\nProject knowledge.\n', base);
        await writeSource('web/core/library.php', undefined, base);
        await writeSource('web/modules/custom/project/project.php', undefined, base);
      }
      repo.scopeExcludeGlobs = [];
      await ragReindexStep.apply(ctx, {
        detected: await ragReindexStep.detect!(ctx),
        formValues: { runReindex: true },
        iteration: 0,
        previousIterations: [],
      });
      expect(indexedChunks.get('web/core/library.php')!.length).toBeGreaterThan(0);
      const cached = await preRagSyncStep.detect!(ctx);
      expect(cached.codeCollect.exclude).toEqual([]);
      repo.scopeExcludeGlobs = ['web/core'];
      expect((await preRagSyncStep.detect!(ctx)).codeCollect.exclude).toEqual(['web/core']);
      inserts = [];
      if (scan === 'root') {
        await preRagSyncStep.apply(ctx, {
          detected: cached,
          formValues: { runSync: true },
          iteration: 0,
          previousIterations: [],
        });
      } else {
        await runRagIndexSync(ctx, {
          repoPath: worktree,
          prefs: cached.ragToolingPrefs!,
          projectName: cached.projectName,
          ollamaReachable: cached.ollamaReachable,
          codeCollect: cached.codeCollect,
          sweepProtectedPaths: new Set(['web/core/library.php']),
        });
      }
      expect(inserts.map((row) => row[3])).not.toContain('web/core/library.php');
      expect(indexedChunks.get('web/core/library.php')).toEqual([]);
      expect(indexedChunks.get(kbPath)!.length).toBeGreaterThan(0);
      expect(indexedChunks.get('web/modules/custom/project/project.php')!.length).toBeGreaterThan(
        0,
      );
    },
  );

  it('recognizes Drupal 7 without any onboarding detector or Composer manifest', async () => {
    await writeSource('includes/bootstrap.inc', '<?php function bootstrap() {}');
    await writeSource('modules/system/system.module');
    await writeSource('themes/core/theme.php');
    await writeSource('sites/all/modules/custom/project.module');
    await writeSource('sites/all/themes/custom/theme.php');
    const detected = await workflowRagSourceSelectionStep.detect!(ctx);
    expect(detected.framework).toBe('drupal7');
    expect(detected.defaultExcludeGlobs).toEqual(
      expect.arrayContaining(['includes', 'modules', 'themes']),
    );
    const defaults = collectDefaults(detected.tree, detected.defaultExcludeGlobs);
    expect(defaults).toContain('sites/all/modules/custom');
    expect(defaults).not.toContain('modules/system');
  });

  it('honors root-file and custom-folder unticks, keeps knowledge, and sweeps previously indexed libraries', async () => {
    await writeSource('src/app.ts');
    await writeSource('scratch/debug.ts');
    await writeSource('core/library.php');
    await writeSource('modules/contrib/plugin.php');
    const detected = await workflowRagSourceSelectionStep.detect!(ctx);
    // Untick everything except src. Managed knowledge remains indexable.
    const saved = await saveScope(detected, ['src']);
    expect(saved.excludeGlobs).toEqual(expect.arrayContaining(['.', 'scratch', 'core', 'modules']));
    expect(saved.excludeGlobs).not.toContain('.haive-data');
    stalePaths = ['core/library.php', 'scratch/debug.ts'];
    for (const path of stalePaths) {
      indexedChunks.set(path, [
        { section_id: 'legacy', chunk_index: 0, chunk_hash: 'old', content: 'old library code' },
      ]);
    }
    const reindex = await ragReindexStep.detect!(ctx);
    const result = await ragReindexStep.apply(ctx, {
      detected: reindex,
      formValues: { runReindex: true },
      iteration: 0,
      previousIterations: [],
    });
    expect(result.deleted).toBe(2);
    expect(deletedPaths).toEqual(stalePaths);
    expect(inserts.map((p) => p[3])).toEqual(
      expect.arrayContaining(['src/app.ts', '.haive-data/knowledge_base/architecture.md']),
    );
    expect(inserts.map((p) => p[3])).not.toContain('app.ts');
    expect(inserts.map((p) => p[3])).not.toContain('scratch/debug.ts');
    expect((await resolveRagSyncPrefs(ctx)).codeCollect.exclude).toEqual(saved.excludeGlobs);
  });

  it('refuses an old cached re-index submission and direct sync before scope selection', async () => {
    repo.scopeExcludeGlobs = [];
    const detected = await ragReindexStep.detect!(ctx);
    repo.scopeExcludeGlobs = null;
    expect(
      (
        await ragReindexStep.apply(ctx, {
          detected,
          formValues: { runReindex: true },
          iteration: 0,
          previousIterations: [],
        })
      ).performed,
    ).toBe(false);
    expect(
      (
        await runRagIndexSync(ctx, {
          repoPath: worktree,
          prefs: detected.ragToolingPrefs!,
          projectName: 'new-app',
          ollamaReachable: true,
          codeCollect: {},
        })
      ).performed,
    ).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
