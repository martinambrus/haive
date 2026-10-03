import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ollamaEmbed, probeOllama } from '@haive/shared/rag';
import { resolveRagConnection, type RagToolingPrefs } from '../onboarding/_rag-connection.js';
import type { StepContext } from '../../step-definition.js';
import { retrieveSimilarTaskIds } from './_task-embedding.js';
import { HISTORY_BATCH_SIZE } from './_estimate.js';

vi.mock('@haive/shared/rag', () => ({
  TASK_SOURCE_TYPE: 'task',
  ollamaEmbed: vi.fn(),
  probeOllama: vi.fn(),
  vectorLiteral: (vector: number[]) => `[${vector.join(',')}]`,
}));
vi.mock('../onboarding/_rag-connection.js', () => ({
  RAG_TABLE: 'ai_rag_embeddings',
  resolveRagConnection: vi.fn(),
}));

const prefs = { ollamaUrl: 'http://embedding', embeddingModel: 'model' } as RagToolingPrefs;

/** Pool order represents cosine rank. Filter before streaming cursor batches,
 *  recording each batch so early close and single-query retrieval can be checked. */
function fixture(
  pool: string[],
  matchingIds: string[],
  unmeasured: string[] = [],
  missing: string[] = [],
) {
  const cursorBatches = vi.fn();
  const unsafe = vi.fn((query: string, params: unknown[]) => {
    const eligible = new Set((query.includes('ANY') ? params[4] : []) as string[]);
    const candidates = query.includes('AND NOT (task_id = ANY')
      ? pool.filter((id) => !eligible.has(id))
      : query.includes('AND task_id = ANY')
        ? pool.filter((id) => eligible.has(id))
        : pool;
    return {
      cursor: (size: number) =>
        (async function* () {
          for (let offset = 0; offset < candidates.length; offset += size) {
            const rows = candidates.slice(offset, offset + size).map((task_id) => ({ task_id }));
            cursorBatches(rows);
            yield rows;
          }
        })(),
    };
  });
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(resolveRagConnection).mockResolvedValue({
    pg: { unsafe },
    embeddingDimensions: 2,
    close,
  } as never);
  const findMany = vi.fn(
    async (args: {
      columns: Record<string, boolean>;
      where: Parameters<PgDialect['sqlToQuery']>[0];
    }) => {
      if (!args.columns.title) return matchingIds.map((id) => ({ id }));
      const requested = new Set(new PgDialect().sqlToQuery(args.where).params);
      return pool
        .filter((id) => requested.has(id) && !missing.includes(id))
        .map((id) => ({
          id,
          title: id,
          description: '',
          executionPath: matchingIds.includes(id) ? 'quick_bugfix' : 'full_workflow',
          currentRound: 0,
          changedPaths: [],
          aiEstimatedTimeHours: null,
          estimatedTimeHours: null,
          completedAt: new Date(3_600_000),
        }));
    },
  );
  const ctx = {
    taskId: 'current',
    db: {
      query: {
        tasks: { findMany },
        taskSteps: {
          findMany: vi.fn().mockResolvedValue(
            pool
              .filter((id) => !unmeasured.includes(id))
              .map((taskId) => ({
                taskId,
                startedAt: new Date(0),
                endedAt: new Date(3_600_000),
                idleMs: 0,
                userActiveMs: 0,
                waitingStartedAt: null,
                status: 'done',
              })),
          ),
        },
      },
    },
    logger: { warn: vi.fn() },
  } as unknown as StepContext;
  return { ctx, unsafe, close, findMany, cursorBatches };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(probeOllama).mockResolvedValue(true);
  vi.mocked(ollamaEmbed).mockResolvedValue([[0.1, 0.2]]);
});

describe('retrieveSimilarTaskIds', () => {
  it('ranks same-path embeddings before a full mixed-path result budget', async () => {
    const full = Array.from({ length: 30 }, (_, i) => `full-${i}`);
    const fixes = Array.from({ length: 1035 }, (_, i) => `fix-${i}`);
    const { ctx, unsafe, findMany, close, cursorBatches } = fixture([...full, ...fixes], fixes);
    const ids = await retrieveSimilarTaskIds(
      ctx,
      prefs,
      'project',
      'repo',
      'fix',
      30,
      'quick_bugfix',
    );
    expect(ids).toEqual(fixes.slice(0, 30));
    expect(unsafe).toHaveBeenCalledTimes(1);
    const [query, params] = unsafe.mock.calls[0]!;
    expect(query).toContain('AND task_id = ANY($5::uuid[])');
    expect(params[4]).toHaveLength(1035);
    expect(cursorBatches.mock.calls.map(([rows]) => rows.length)).toEqual([HISTORY_BATCH_SIZE]);
    const eligibility = new PgDialect().sqlToQuery(findMany.mock.calls[0]![0].where);
    expect(eligibility.params).toEqual([
      'repo',
      'workflow',
      'completed',
      'current',
      'quick_bugfix',
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('tops up sparse same-path embeddings with broader semantic matches without duplicates', async () => {
    const { ctx, unsafe } = fixture(
      ['full-1', 'fix-1', 'full-2', 'fix-2', 'full-3'],
      ['fix-1', 'fix-2'],
    );
    const ids = await retrieveSimilarTaskIds(
      ctx,
      prefs,
      'project',
      'repo',
      'fix',
      4,
      'quick_bugfix',
    );
    expect(ids).toEqual(['fix-1', 'fix-2', 'full-1', 'full-2']);
    expect(unsafe.mock.calls[1]![0]).toContain('AND NOT (task_id = ANY($5::uuid[]))');
  });

  it('preserves cosine ranking when the current path is unknown', async () => {
    const { ctx, unsafe, findMany } = fixture(['full', 'fix'], ['fix']);
    expect(await retrieveSimilarTaskIds(ctx, prefs, 'project', 'repo', 'text', 2)).toEqual([
      'full',
      'fix',
    ]);
    expect(findMany).toHaveBeenCalledTimes(1); // measured-result validation, no path eligibility query
    expect(unsafe).toHaveBeenCalledTimes(1);
    expect(unsafe.mock.calls[0]![0]).not.toContain('ANY');
  });

  it('falls back without a RAG query when embedding is unavailable', async () => {
    const { ctx, unsafe } = fixture(['fix'], ['fix']);
    vi.mocked(probeOllama).mockResolvedValue(false);
    expect(
      await retrieveSimilarTaskIds(ctx, prefs, 'project', 'repo', 'fix', 30, 'quick_bugfix'),
    ).toEqual([]);
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('pages past unmeasured same-path embeddings to older measured semantic matches', async () => {
    const unmeasured = Array.from({ length: HISTORY_BATCH_SIZE }, (_, i) => `unmeasured-${i}`);
    const fixes = ['older-fix-1', 'older-fix-2', 'older-fix-3'];
    const { ctx, unsafe, cursorBatches } = fixture(
      [...unmeasured, ...fixes],
      [...unmeasured, ...fixes],
      unmeasured,
    );
    expect(
      await retrieveSimilarTaskIds(ctx, prefs, 'project', 'repo', 'fix', 30, 'quick_bugfix'),
    ).toEqual(fixes);
    expect(unsafe.mock.calls.filter(([query]) => query.includes('AND task_id = ANY'))).toHaveLength(
      1,
    );
    expect(cursorBatches.mock.calls.map(([rows]) => rows.length)).toEqual([HISTORY_BATCH_SIZE, 3]);
  });

  it('fills sparse history with measured broader matches after exhausting unmeasured same-path embeddings', async () => {
    const unmeasured = Array.from({ length: HISTORY_BATCH_SIZE }, (_, i) => `unmeasured-${i}`);
    const { ctx, unsafe } = fixture([...unmeasured, 'full-1', 'full-2'], unmeasured, unmeasured);
    expect(
      await retrieveSimilarTaskIds(ctx, prefs, 'project', 'repo', 'fix', 30, 'quick_bugfix'),
    ).toEqual(['full-1', 'full-2']);
    expect(unsafe.mock.calls[1]![0]).toContain('AND NOT (task_id = ANY');
  });

  it('scans broader history in full pages when only one measured anchor remains', async () => {
    const fixes = Array.from({ length: 29 }, (_, i) => `fix-${i}`);
    const unmeasured = Array.from({ length: 1000 }, (_, i) => `unmeasured-${i}`);
    const { ctx, unsafe, findMany, cursorBatches } = fixture(
      [...fixes, ...unmeasured, 'broader-measured', 'broader-extra'],
      fixes,
      unmeasured,
    );

    expect(
      await retrieveSimilarTaskIds(ctx, prefs, 'project', 'repo', 'fix', 30, 'quick_bugfix'),
    ).toEqual([...fixes, 'broader-measured']);
    expect(unsafe).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls.length).toBeLessThan(10);
    expect(cursorBatches.mock.calls.map(([rows]) => rows.length)).toEqual([29, 500, 500, 2]);
  });

  it('does not count stale task ids as measured anchors even when their timing rows remain', async () => {
    const { ctx } = fixture(['stale', 'fix'], ['stale', 'fix'], [], ['stale']);
    expect(
      await retrieveSimilarTaskIds(ctx, prefs, 'project', 'repo', 'fix', 2, 'quick_bugfix'),
    ).toEqual(['fix']);
  });

  it('closes the store and degrades to recency if the path-aware query fails', async () => {
    const { ctx, unsafe, close } = fixture(['fix'], ['fix']);
    unsafe.mockImplementationOnce(() => {
      throw new Error('store unavailable');
    });
    expect(
      await retrieveSimilarTaskIds(ctx, prefs, 'project', 'repo', 'fix', 30, 'quick_bugfix'),
    ).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
    expect(ctx.logger.warn).toHaveBeenCalledOnce();
  });
});
