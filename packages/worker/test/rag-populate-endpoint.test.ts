import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '@haive/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCancelledError, type StepContext } from '../src/step-engine/step-definition.js';
import type { createFakeRagLock } from './rag-lock-fake.js';

const lockFake = vi.hoisted(() => ({ value: undefined as unknown }));
const mocks = vi.hoisted(() => ({
  connects: 0,
  gate: null as Promise<void> | null,
  taskRepositoryId: 'repo-1' as string | null,
  strict: true,
  embedFails: false,
  ollamaEmbed: vi.fn(async (_url: string, _model: string, texts: string[]) => {
    if (mocks.embedFails) throw new Error('connection refused');
    return texts.map(() => [0.1, 0.2]);
  }),
}));
vi.mock('@haive/shared/rag', async (original) => {
  const actual = await original<typeof import('@haive/shared/rag')>();
  const { createFakeRagLock: create } = await import('./rag-lock-fake.js');
  const fake = create(actual);
  lockFake.value = fake;
  return {
    ...actual,
    acquireRagSyncLock: fake.acquireRagSyncLock,
    tryAcquireRagSyncLock: fake.tryAcquireRagSyncLock,
    ollamaEmbed: mocks.ollamaEmbed,
    resolveEmbedBudget: async () => ({
      embedTimeoutMs: 1000,
      queryTimeoutMs: 1000,
      warmupTimeoutMs: 1000,
      batchSize: 8,
      strict: mocks.strict,
    }),
  };
});
vi.mock('../src/redis.js', async (original) => ({
  ...(await original<object>()),
  getRedis: () => ({}),
}));
vi.mock('../src/step-engine/steps/onboarding/_rag-connection.js', async (original) => ({
  ...(await original<object>()),
  resolveRagConnection: async () => {
    mocks.connects += 1;
    return conn;
  },
  ensureRagSchema: async () => {
    await mocks.gate;
    return { usedPgvector: false, tableName: 'ai_rag_embeddings' };
  },
}));
vi.mock('../src/step-engine/steps/onboarding/_rag-embed.js', async (original) => ({
  ...(await original<object>()),
  warmOllamaModel: async () => false,
}));

const { ragPopulateStep, RagEmbedFailureError } =
  await import('../src/step-engine/steps/onboarding/10-rag-populate.js').then(async (m) => ({
    ragPopulateStep: m.ragPopulateStep,
    RagEmbedFailureError: (await import('../src/step-engine/steps/_rag-embed-health.js'))
      .RagEmbedFailureError,
  }));

const fakeLock = lockFake.value as ReturnType<typeof createFakeRagLock>;
const KB = '.haive-data/knowledge_base/architecture.md';
let root: string;
let rows: Map<string, { hash: string | null; params: unknown[] }>;
let order: string[];
let failInsertAt: number | null;
let failDegradedWrite: boolean;
let leftoverNullHash: boolean;
let nullHashProbeFails: boolean;
let nullHashProbes: unknown[][];
let warnings: Array<string | null>;
let repo: Record<string, unknown>;
let conn: unknown;
let ctx: StepContext;

const detected = (over: Record<string, unknown> = {}) => ({
  kbFiles: [{ relPath: KB, sizeBytes: 60 }],
  codeFiles: [],
  ollamaReachable: false,
  ollamaUrl: 'http://ollama:11434' as string | null,
  embeddingModel: 'qwen3-embedding:4b' as string | null,
  embeddingDimensions: 2,
  ragMode: 'internal' as const,
  ragConnectionString: null,
  projectName: 'p',
  ...over,
});

const populate = (d: ReturnType<typeof detected>) =>
  ragPopulateStep.apply(ctx, {
    detected: d,
    formValues: { populateMode: 'incremental' },
    iteration: 0,
    previousIterations: [],
  });

beforeEach(async () => {
  vi.clearAllMocks();
  fakeLock.reset();
  mocks.connects = 0;
  mocks.gate = null;
  mocks.taskRepositoryId = 'repo-1';
  mocks.strict = true;
  mocks.embedFails = false;
  root = await mkdtemp(join(tmpdir(), 'haive-rag-populate-'));
  await mkdir(join(root, '.haive-data/knowledge_base'), { recursive: true });
  await writeFile(
    join(root, KB),
    '# Architecture\n\nThe app stores its documents in PostgreSQL.\n',
  );
  rows = new Map();
  order = [];
  failInsertAt = null;
  failDegradedWrite = false;
  leftoverNullHash = false;
  nullHashProbeFails = false;
  nullHashProbes = [];
  warnings = [];
  repo = { ragEmbedDegradedAt: null, ragEmbedDegradedReason: null, ragEmbedLexicalOnly: false };
  conn = {
    close: async () => {},
    pg: {
      unsafe: async (query: string, params: unknown[] = []) => {
        if (query.includes('INSERT INTO')) {
          order.push('insert');
          if (failInsertAt !== null && order.filter((e) => e === 'insert').length === failInsertAt)
            throw new Error('store went away');
          rows.set(JSON.stringify([params[3], params[4], params[5]]), {
            hash: params[6] as string | null,
            params,
          });
        }
        if (query.includes('chunk_hash IS NULL') && query.startsWith('SELECT')) {
          nullHashProbes.push(params);
          if (nullHashProbeFails) throw new Error('store read failed');
          const stored = [...rows.values()].some((r) => r.hash === null);
          return leftoverNullHash || stored ? [{ found: 1 }] : [];
        }
        if (query.includes('SELECT source_path, section_id, chunk_index, chunk_hash'))
          return [...rows.values()].map((r) => ({
            source_path: r.params[3],
            section_id: r.params[4],
            chunk_index: r.params[5],
            chunk_hash: r.hash,
          }));
        return Object.assign([], { count: 0 });
      },
    },
  };
  ctx = {
    db: {
      query: {
        tasks: { findFirst: async () => ({ repositoryId: mocks.taskRepositoryId }) },
        repositories: { findFirst: async () => repo },
      },
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (table === schema.taskSteps && 'warningMessage' in values)
              warnings.push(values.warningMessage as string | null);
            if (failDegradedWrite && table === schema.repositories && values.ragEmbedDegradedAt)
              throw new Error('database is down');
            if (table === schema.repositories && 'ragEmbedDegradedAt' in values)
              order.push('degraded');
            if (table === schema.repositories) Object.assign(repo, values);
            return [];
          },
        }),
      }),
    },
    taskId: 'task-1',
    taskStepId: 'step-1',
    repoPath: root,
    workspacePath: root,
    emitProgress: async () => {},
    throwIfCancelled: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as StepContext;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const storedHashes = () => [...rows.values()].map((r) => r.hash);

describe('onboarding populate with an embedding endpoint configured', () => {
  it('attempts to embed when the probe failed, and under strict mode fails the step', async () => {
    mocks.embedFails = true;
    await expect(populate(detected({ ollamaReachable: false }))).rejects.toBeInstanceOf(
      RagEmbedFailureError,
    );
    expect(mocks.ollamaEmbed).toHaveBeenCalled();
    expect(rows.size).toBe(0);
    expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
  });

  it('hashes and passes when no endpoint is configured, with real hashes and no degradation', async () => {
    const result = await populate(
      detected({ ollamaUrl: null, embeddingModel: null, ollamaReachable: false }),
    );
    expect(result.usedOllama).toBe(false);
    expect(mocks.ollamaEmbed).not.toHaveBeenCalled();
    expect(rows.size).toBeGreaterThan(0);
    expect(storedHashes().every((h) => typeof h === 'string')).toBe(true);
    expect(repo.ragEmbedDegradedAt).toBeNull();
  });

  it('leaves a NULL chunk_hash and degradation when strict is off and the embed fails', async () => {
    mocks.strict = false;
    mocks.embedFails = true;
    await populate(detected({ ollamaReachable: true }));
    expect(rows.size).toBeGreaterThan(0);
    expect(storedHashes().every((h) => h === null)).toBe(true);
    expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);

    mocks.embedFails = false;
    mocks.ollamaEmbed.mockClear();
    const healed = await populate(detected({ ollamaReachable: true }));
    expect(mocks.ollamaEmbed).toHaveBeenCalled();
    expect(healed.chunksEmbedded).toBe(rows.size);
    expect(storedHashes().every((h) => typeof h === 'string')).toBe(true);
    expect(repo.ragEmbedDegradedAt).toBeNull();
  });

  it('records the degradation once, before the first hashed row is upserted, so an aborted run keeps it', async () => {
    mocks.strict = false;
    mocks.embedFails = true;
    const other = '.haive-data/knowledge_base/other.md';
    await writeFile(join(root, other), '# Other\n\nA second document about queues.\n');
    failInsertAt = 2;
    await expect(
      populate(
        detected({
          ollamaReachable: true,
          kbFiles: [
            { relPath: KB, sizeBytes: 60 },
            { relPath: other, sizeBytes: 40 },
          ],
        }),
      ),
    ).rejects.toThrow('store went away');
    expect(order.slice(0, 2)).toEqual(['degraded', 'insert']);
    expect(order.filter((event) => event === 'degraded')).toHaveLength(1);
    expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
  });

  it('writes no hashed row when the degradation could not be stored', async () => {
    mocks.strict = false;
    mocks.embedFails = true;
    failDegradedWrite = true;
    await expect(populate(detected({ ollamaReachable: true }))).rejects.toThrow('database is down');
    expect(order).not.toContain('insert');
    expect(rows.size).toBe(0);
    expect(repo.ragEmbedDegradedAt).toBeNull();
  });

  it('keeps the flag over a leftover NULL-hash row the run did not re-embed', async () => {
    repo.ragEmbedDegradedAt = new Date(0);
    leftoverNullHash = true;
    await populate(detected({ ollamaReachable: true }));
    expect(storedHashes().every((h) => typeof h === 'string')).toBe(true);
    expect(nullHashProbes).toEqual([
      ['repo-1', 'task'],
      ['repo-1', 'task'],
    ]);
    expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
  });

  it('keeps the flag when the sync lock was lost during the run', async () => {
    repo.ragEmbedDegradedAt = new Date(0);
    fakeLock.state.loseOnTake = true;
    await populate(detected({ ollamaReachable: true }));
    expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
  });

  it('clears the flag when the store holds no NULL-hash row', async () => {
    repo.ragEmbedDegradedAt = new Date(0);
    await populate(detected({ ollamaReachable: true }));
    expect(repo.ragEmbedDegradedAt).toBeNull();
  });

  it('keeps the flag when the run embedded nothing for real', async () => {
    repo.ragEmbedDegradedAt = new Date(0);
    await populate(detected({ ollamaReachable: true, kbFiles: [] }));
    expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
  });

  it('keeps the flag when the NULL-hash read fails', async () => {
    repo.ragEmbedDegradedAt = new Date(0);
    nullHashProbeFails = true;
    await populate(detected({ ollamaReachable: true }));
    expect(nullHashProbes).toHaveLength(2);
    expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
  });

  it('words a fallback-only run as fallback vectors, not as unsearchable chunks', async () => {
    mocks.strict = false;
    mocks.embedFails = true;
    await populate(detected({ ollamaReachable: true }));
    const warning = warnings.at(-1)!;
    expect(warning).toContain('fallback vectors');
    expect(warning).toContain('re-embedded on the next sync');
    expect(warning).not.toContain('not searchable');
  });

  describe('the first banner of a run on a degraded repository', () => {
    it('words rows awaiting re-embed as searchable by words, not as unsearchable', async () => {
      repo.ragEmbedDegradedAt = new Date(0);
      repo.ragEmbedDegradedReason = 'Ollama is unreachable';
      leftoverNullHash = true;
      await populate(detected({ ollamaReachable: true }));
      expect(warnings[0]).toContain('fallback vectors');
      expect(warnings[0]).toContain('re-embedded on the next sync');
      expect(warnings[0]).not.toContain('not searchable');
    });

    it('keeps the unindexed wording when no row awaits re-embed', async () => {
      repo.ragEmbedDegradedAt = new Date(0);
      repo.ragEmbedDegradedReason = 'Ollama is unreachable';
      await populate(detected({ ollamaReachable: true }));
      expect(warnings[0]).toContain('not searchable yet');
      expect(warnings[0]).not.toContain('fallback vectors');
    });

    it('keeps the unindexed wording when the read fails', async () => {
      repo.ragEmbedDegradedAt = new Date(0);
      nullHashProbeFails = true;
      await populate(detected({ ollamaReachable: true }));
      expect(warnings[0]).toContain('not searchable yet');
    });

    it('reads the store once for the first banner, besides the read that ends the run', async () => {
      repo.ragEmbedDegradedAt = new Date(0);
      await populate(detected({ ollamaReachable: true }));
      expect(nullHashProbes).toHaveLength(2);
    });

    it('never reads the store for a healthy repository', async () => {
      await populate(detected({ ollamaReachable: true }));
      expect(nullHashProbes).toEqual([]);
    });
  });

  it('keeps the strict-failure wording when the step fails', async () => {
    mocks.embedFails = true;
    await expect(populate(detected({ ollamaReachable: false }))).rejects.toBeInstanceOf(
      RagEmbedFailureError,
    );
    const warning = warnings.at(-1)!;
    expect(warning).toContain('Chunks left unindexed by the failure are not searchable yet');
    expect(warning).not.toContain('fallback vectors');
  });

  it('keeps a degradation recorded earlier when this run wrote hash vectors', async () => {
    mocks.strict = false;
    mocks.embedFails = true;
    repo.ragEmbedDegradedAt = new Date(0);
    await populate(detected({ ollamaReachable: true }));
    expect(repo.ragEmbedDegradedAt).toBeInstanceOf(Date);
  });

  it('writes the same rows as before when embedding works', async () => {
    await populate(detected({ ollamaReachable: true }));
    expect([...rows.values()].map((r) => r.params)).toMatchInlineSnapshot(`
      [
        [
          "task-1",
          "repo-1",
          "kb",
          ".haive-data/knowledge_base/architecture.md",
          "architecture",
          0,
          "90e379bc783064249992bd15e1d88b7b4d619a316d4ec7b0172d3c80dfa761ee",
          "[.haive-data/knowledge_base/architecture.md > Architecture]

      # Architecture

      The app stores its documents in PostgreSQL.",
          "[0.1,0.2]",
        ],
      ]
    `);
    expect(repo.ragEmbedDegradedAt).toBeNull();
  });
});

describe('onboarding populate holds the repository RAG lock', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps a second populate of one repository off the store until the first released', async () => {
    let open!: () => void;
    mocks.gate = new Promise<void>((resolve) => (open = resolve));
    const first = populate(detected());
    for (let i = 0; i < 100 && mocks.connects < 1; i += 1) await sleep(5);
    const progress: string[] = [];
    const second = ragPopulateStep.apply(
      { ...ctx, emitProgress: async (m: string) => void progress.push(m) } as StepContext,
      {
        detected: detected(),
        formValues: { populateMode: 'incremental' },
        iteration: 0,
        previousIterations: [],
      },
    );
    await sleep(150);
    expect(mocks.connects).toBe(1);
    expect(progress.join('\n')).toMatch(/another RAG sync of this repository/i);
    mocks.gate = null;
    open();
    await Promise.all([first, second]);
    expect(mocks.connects).toBe(2);
    expect(fakeLock.state.handles.map((h) => h.released)).toEqual([1, 1]);
    expect(fakeLock.state.tried[0]!.options?.waitMs).toBe(2 * 60 * 60 * 1000);
  });

  it('fails with a clear message past the bound, before connecting', async () => {
    fakeLock.state.held.add('repo-1');
    fakeLock.state.timeoutNow = true;
    await expect(populate(detected())).rejects.toThrow(/another RAG sync of this repository/i);
    expect(mocks.connects).toBe(0);
  });

  it('ends as cancelled when the task is stopped while it waits', async () => {
    fakeLock.state.held.add('repo-1');
    const controller = new AbortController();
    const waiting = ragPopulateStep.apply({ ...ctx, signal: controller.signal } as StepContext, {
      detected: detected(),
      formValues: { populateMode: 'incremental' },
      iteration: 0,
      previousIterations: [],
    });
    const settled = expect(waiting).rejects.toBeInstanceOf(TaskCancelledError);
    await sleep(40);
    controller.abort();
    await settled;
    expect(mocks.connects).toBe(0);
  });

  it('releases the lock when the populate fails', async () => {
    mocks.embedFails = true;
    await expect(populate(detected({ ollamaReachable: false }))).rejects.toBeInstanceOf(
      RagEmbedFailureError,
    );
    expect(fakeLock.state.handles.map((h) => h.released)).toEqual([1]);
  });

  it('takes no lock when the task has no repository', async () => {
    mocks.taskRepositoryId = null;
    await populate(detected());
    expect(fakeLock.state.tried).toEqual([]);
  });

  it('takes no lock when the mode is none', async () => {
    await populate(detected({ ragMode: 'none' as never }));
    expect(fakeLock.state.tried).toEqual([]);
  });
});
