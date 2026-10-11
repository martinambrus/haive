import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../logger/index.js', () => ({
  logger: { child: () => ({ warn: h.warn }), info: () => {}, warn: () => {}, error: () => {} },
}));

import type { RagConnection } from './connection.js';
import {
  DEFAULT_RAG_SEARCH_CONFIG,
  applyKnowledgeReserve,
  ragHybridSearch,
  type RagSearchHit,
} from './search.js';

const OPTS = {
  topK: 8,
  knowledgeReserve: DEFAULT_RAG_SEARCH_CONFIG.knowledgeReserve,
  knowledgeReserveRatio: DEFAULT_RAG_SEARCH_CONFIG.knowledgeReserveRatio,
};

/** A hit whose only meaningful fields are the ones the reserve reads. `rrf`
 *  defaults to a value derived from denseSim so a plain page is already ranked
 *  the way the fusion would rank it; pass `rrf: 0` for a promoted candidate. */
function hit(
  sourceType: string,
  denseSim: number,
  overrides: Partial<RagSearchHit> = {},
): RagSearchHit {
  return {
    sourcePath: `${sourceType}/${denseSim}`,
    sectionId: 's',
    chunkIndex: 0,
    sourceType,
    content: '',
    denseSim,
    tsNorm: 0,
    hybrid: 0,
    rrf: denseSim / 100,
    ...overrides,
  };
}

const paths = (hits: RagSearchHit[]): string[] => hits.map((h) => h.sourcePath);

describe('applyKnowledgeReserve', () => {
  it('promotes a knowledge candidate the page would otherwise cut', () => {
    // The measured shape: a full page of code, plus a KB chunk that lost on rank
    // (rrf 0 because it never entered the fused candidate pool) but is close on
    // dense similarity.
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    const candidate = hit('kb', 0.59, { sourcePath: 'kb/ARCHITECTURE.md', rrf: 0 });

    const out = applyKnowledgeReserve([...page, candidate], OPTS);

    expect(out).toHaveLength(8);
    expect(paths(out)).toContain('kb/ARCHITECTURE.md');
    // The weakest code row made way; the strongest is untouched.
    expect(paths(out)).toContain('code/0.78');
    expect(paths(out)).not.toContain('code/0.64');
  });

  it('stands down when the best knowledge candidate is too far below the top code hit', () => {
    // The symbol-lookup case: measured ratio 0.630, below the 0.75 floor.
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.7355 - i * 0.02));
    const candidate = hit('kb', 0.4633, { sourcePath: 'kb/unrelated.md', rrf: 0 });

    const out = applyKnowledgeReserve([...page, candidate], OPTS);

    expect(out).toHaveLength(8);
    expect(paths(out)).not.toContain('kb/unrelated.md');
    expect(out).toEqual(page);
  });

  it('leaves a page that already ranks its knowledge hits exactly as it was', () => {
    // A floor on presence, never a re-ordering: a KB hit that earned rank 2 stays
    // at rank 2 rather than being moved into a reserved slot at the end.
    const page = [
      hit('code', 0.7),
      hit('kb', 0.68),
      hit('code', 0.66),
      hit('kb', 0.64),
      hit('code', 0.62),
      hit('code', 0.6),
      hit('code', 0.58),
      hit('code', 0.56),
    ];

    expect(applyKnowledgeReserve([...page], OPTS)).toEqual(page);
  });

  it('never returns more than topK, and fills spare slots with code', () => {
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    // Four eligible candidates, but only two slots are reserved.
    const candidates = [0.6, 0.59, 0.58, 0.57].map((s, i) =>
      hit('kb', s, { sourcePath: `kb/${i}.md`, rrf: 0 }),
    );

    const out = applyKnowledgeReserve([...page, ...candidates], OPTS);

    expect(out).toHaveLength(8);
    expect(out.filter((h) => h.sourceType === 'kb')).toHaveLength(2);
    // The two best by dense similarity, not by rrf (they all share rrf 0).
    expect(paths(out)).toEqual(expect.arrayContaining(['kb/0.md', 'kb/1.md']));
    expect(paths(out)).not.toContain('kb/3.md');
  });

  it('reserves proportionally so a small page is not handed over', () => {
    // topK 4 -> floor(4/3) = 1 slot, not 2. Measured: top_k reaches this route as
    // low as 4.
    const page = Array.from({ length: 4 }, (_, i) => hit('code', 0.61 - i * 0.02));
    const candidates = [0.52, 0.51].map((s, i) =>
      hit('kb', s, { sourcePath: `kb/${i}.md`, rrf: 0 }),
    );

    const out = applyKnowledgeReserve([...page, ...candidates], { ...OPTS, topK: 4 });

    expect(out).toHaveLength(4);
    expect(out.filter((h) => h.sourceType === 'kb')).toHaveLength(1);
  });

  it('is a no-op on a result set with no code, which is the global KB store', () => {
    const page = [hit('kb', 0.7), hit('kb', 0.6), hit('kb', 0.5)];

    expect(applyKnowledgeReserve([...page], OPTS)).toEqual(page);
  });

  it('never promotes a task-embedding row', () => {
    // `task` rows are keyed by task UUID for the effort estimator and are not
    // knowledge; they also have no counter in the api's rag_query_log bucketing,
    // so one surfacing here would be an invisible hit.
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    const candidate = hit('task', 0.77, { sourcePath: 'task/uuid', rrf: 0 });

    const out = applyKnowledgeReserve([...page, candidate], OPTS);

    expect(paths(out)).not.toContain('task/uuid');
    expect(out).toEqual(page);
  });

  it('promotes runbook and learning chunks, not only kb', () => {
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    const candidates = [
      hit('runbook', 0.62, { sourcePath: 'rb/one.md', rrf: 0 }),
      hit('learning', 0.61, { sourcePath: 'ln/one.md', rrf: 0 }),
    ];

    const out = applyKnowledgeReserve([...page, ...candidates], OPTS);

    expect(paths(out)).toEqual(expect.arrayContaining(['rb/one.md', 'ln/one.md']));
  });

  it('keeps the reserve when the page is trimmed, which is the mergeHits path', () => {
    // mergeHits trims the local page to make room for the global KB. The promoted
    // hit carries the low rrf that got it cut in the first place, so a plain rrf
    // slice would drop it first.
    const page = [
      ...Array.from({ length: 6 }, (_, i) => hit('code', 0.78 - i * 0.02)),
      hit('kb', 0.6, { sourcePath: 'kb/kept.md', rrf: 0 }),
    ];

    const out = applyKnowledgeReserve(page, { ...OPTS, topK: 4 });

    expect(out).toHaveLength(4);
    expect(paths(out)).toContain('kb/kept.md');
  });

  it('restores the previous ranking exactly when the reserve is disabled', () => {
    const page = Array.from({ length: 8 }, (_, i) => hit('code', 0.78 - i * 0.02));
    const candidate = hit('kb', 0.6, { sourcePath: 'kb/one.md', rrf: 0 });

    const out = applyKnowledgeReserve([...page, candidate], { ...OPTS, knowledgeReserve: 0 });

    expect(out).toEqual(page);
  });

  it('returns nothing for a non-positive topK', () => {
    expect(applyKnowledgeReserve([hit('code', 0.5)], { ...OPTS, topK: 0 })).toEqual([]);
  });
});

/** Keeps every statement with its parameters, and answers the identifier statistics so the ranker runs. */
function recordingConn(df = 1): {
  conn: RagConnection;
  calls: Array<{ statement: string; params: unknown[] }>;
} {
  const calls: Array<{ statement: string; params: unknown[] }> = [];
  const pg: Record<string, unknown> = {
    unsafe: async (statement: string, params: unknown[] = []) => {
      calls.push({ statement, params });
      if (statement.includes('information_schema.columns')) return [{ column_name: 'vector' }];
      if (statement.includes('AS t(term)')) return [{ term: 'getuserbyid', df, total: 10 }];
      return [];
    },
    savepoint: async (run: (sp: unknown) => unknown) => run(pg),
  };
  return {
    conn: { mode: 'external', pg, embeddingDimensions: 4, close: async () => {} } as never,
    calls,
  };
}

describe('ragHybridSearch parameters', () => {
  const QUERY = 'getUserById validation';
  const VEC = [0.1, 0.2, 0.3, 0.4];
  const FILTER = { namespace: 'default', facets: { framework: ['drupal'] }, embedModel: 'model-a' };

  it.each([
    ['a facet filter, the global KB', FILTER, undefined],
    ['a repository scope', undefined, 'repo-1'],
  ])(
    'binds no JS array, which a connection that fetched no array types cannot send: %s',
    async (_scope, filter, repositoryId) => {
      const { conn, calls } = recordingConn();

      await ragHybridSearch(conn, VEC, QUERY, {}, filter, repositoryId);

      expect(calls.some((c) => c.statement.includes('ident AS ('))).toBe(true);
      expect(calls.flatMap((c) => c.params).filter(Array.isArray)).toEqual([]);
    },
  );

  it('binds the identifier terms and their weights as array literals', async () => {
    const { conn, calls } = recordingConn();

    await ragHybridSearch(conn, VEC, QUERY, {}, FILTER);

    const stats = calls.find((c) => c.statement.includes('AS t(term)'))!;
    expect(stats.params[0]).toBe('{"getuserbyid"}');
    const main = calls.find((c) => c.statement.includes('ident AS ('))!;
    expect(main.params.slice(-3)).toEqual([
      '{"getuserbyid"}',
      `{${Math.log(10)}}`,
      "'getuserbyid'",
    ]);
  });
});

/** A store as postgres.js hands one out. In a transaction a failed statement aborts it and only a savepoint takes that back. */
function fakeStore(opts: { transaction: boolean; statisticsFail: boolean }): {
  conn: RagConnection;
  calls: Array<{ statement: string; savepoint: boolean }>;
} {
  const calls: Array<{ statement: string; savepoint: boolean }> = [];
  let aborted = false;
  let inSavepoint = false;
  const pg: Record<string, unknown> = {
    unsafe: async (statement: string) => {
      if (aborted) {
        throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
      }
      calls.push({ statement, savepoint: inSavepoint });
      if (statement.includes('information_schema.columns')) return [{ column_name: 'vector' }];
      if (statement.includes('AS t(term)')) {
        if (opts.statisticsFail) {
          aborted = opts.transaction && !inSavepoint;
          throw Object.assign(new Error('division by zero'), { code: '22012' });
        }
        return [{ term: 'getuserbyid', df: 1, total: 10 }];
      }
      if (statement.includes('dense_c')) {
        return [
          {
            source_path: 'src/auth.ts',
            section_id: 's',
            chunk_index: 0,
            source_type: 'code',
            content: 'getUserById',
            dense_sim: 0.8,
            ts_norm: 0,
            hybrid: 0,
            rrf: 0.01,
          },
        ];
      }
      return [];
    },
  };
  if (opts.transaction) {
    pg.savepoint = async (run: (sp: unknown) => unknown) => {
      inSavepoint = true;
      try {
        return await run(pg);
      } finally {
        inSavepoint = false;
      }
    };
  }
  return {
    conn: { mode: 'external', pg, embeddingDimensions: 4, close: async () => {} } as never,
    calls,
  };
}

describe('ragHybridSearch knowledge candidates', () => {
  const row = (type: string, path: string, rrf: number, id: string, content = '') => ({
    source_path: path,
    section_id: 's',
    chunk_index: 0,
    source_type: type,
    content,
    dense_sim: 0.7,
    ts_norm: 0,
    hybrid: 0,
    rrf,
    id,
  });
  const search = (fused: unknown[], candidates: unknown[], hasRepositoryColumn = true) => {
    const pg = {
      unsafe: async (statement: string) => {
        if (!hasRepositoryColumn && statement.includes('repository_id')) {
          throw Object.assign(new Error('column "repository_id" does not exist'), {
            code: '42703',
          });
        }
        if (statement.includes('information_schema.columns')) return [{ column_name: 'vector' }];
        if (statement.includes('dense_c')) return fused;
        if (statement.includes('ANY($2::text[])')) return candidates;
        return [];
      },
    };
    const conn = { mode: 'external', pg, embeddingDimensions: 4, close: async () => {} } as never;
    return ragHybridSearch(conn, [0.1, 0.2, 0.3, 0.4], 'where is the session cookie set');
  };

  it('returns a knowledge chunk once when the candidate query reaches it too', async () => {
    const hits = await search(
      [row('code', 'src/a.ts', 0.03, '1'), row('kb', 'docs/ARCHITECTURE.md', 0.0158, '2')],
      [row('kb', 'docs/ARCHITECTURE.md', 0, '2')],
    );

    expect(hits.map((x) => x.sourcePath)).toEqual(['src/a.ts', 'docs/ARCHITECTURE.md']);
    expect(hits[1]!.rrf).toBe(0.0158);
  });

  it('keeps two repositories fused rows that share a path, section and index', async () => {
    const hits = await search(
      [
        row('code', 'src/a.ts', 0.03, '1'),
        row('kb', 'README.md', 0.0158, '2', 'one'),
        row('kb', 'README.md', 0.0157, '3', 'two'),
      ],
      [],
    );

    expect(hits.map((x) => x.content)).toEqual(['', 'one', 'two']);
  });

  it('keeps a candidate that is another row at the same path', async () => {
    const hits = await search(
      [row('code', 'src/a.ts', 0.03, '1'), row('kb', 'README.md', 0.0158, '2', 'one')],
      [row('kb', 'README.md', 0, '3', 'two')],
    );

    expect(hits.map((x) => x.content)).toEqual(['', 'one', 'two']);
  });

  it('searches a store with no repository_id column, which is the global KB', async () => {
    const hits = await search(
      [row('code', 'src/a.ts', 0.03, '1'), row('kb', 'docs/ARCHITECTURE.md', 0.0158, '2')],
      [row('kb', 'docs/ARCHITECTURE.md', 0, '2')],
      false,
    );

    expect(hits.map((x) => x.sourcePath)).toEqual(['src/a.ts', 'docs/ARCHITECTURE.md']);
  });
});

describe('ragHybridSearch identifier statistics', () => {
  beforeEach(() => h.warn.mockClear());

  const QUERY = 'getUserById validation';
  const VEC = [0.1, 0.2, 0.3, 0.4];
  const mainStatement = (calls: Array<{ statement: string }>) =>
    calls.find((c) => c.statement.includes('dense_c'))?.statement;

  it('keeps the identifier ranker when it runs the statistics inside a transaction', async () => {
    const { conn, calls } = fakeStore({ transaction: true, statisticsFail: false });

    const hits = await ragHybridSearch(conn, VEC, QUERY);

    expect(hits.map((h) => h.sourcePath)).toEqual(['src/auth.ts']);
    expect(calls.find((c) => c.statement.includes('AS t(term)'))!.savepoint).toBe(true);
    expect(mainStatement(calls)).toContain('ident AS (');
  });

  it.each([
    ['inside a transaction', true],
    ['outside one', false],
  ])(
    'answers without the identifier ranker when the statistics fail %s',
    async (_where, transaction) => {
      const { conn, calls } = fakeStore({ transaction, statisticsFail: true });

      const hits = await ragHybridSearch(conn, VEC, QUERY);

      expect(hits.map((h) => h.sourcePath)).toEqual(['src/auth.ts']);
      expect(mainStatement(calls)).not.toContain('ident AS (');
    },
  );

  it('logs one warning carrying the SQLSTATE and nothing of the query', async () => {
    const { conn } = fakeStore({ transaction: false, statisticsFail: true });

    await ragHybridSearch(conn, VEC, QUERY);

    expect(h.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(h.warn.mock.calls[0]);
    expect(h.warn.mock.calls[0]![0]).toMatchObject({ code: '22012' });
    expect(logged).not.toContain('getuserbyid');
    expect(logged).not.toContain('content_tsv');
  });

  it.each([
    ['the hybrid branch', VEC, false],
    ['the lexical-only branch', [], true],
  ])('counts no task row toward df or the total on %s', async (_branch, vec, lexicalOnly) => {
    const { conn, calls } = recordingConn();

    await ragHybridSearch(conn, vec, QUERY, { lexicalOnly }, undefined, 'repo-1');

    const stats = calls.find((c) => c.statement.includes('AS t(term)'))!.statement;
    expect(stats).toContain(
      "FROM ai_rag_embeddings WHERE repository_id = $2 AND source_type <> 'task'",
    );
    expect(stats).toContain("WHERE repository_id = $2 AND source_type <> 'task' AND e.content_tsv");
  });

  it('keeps an identifier found in every scoped row, whose ln(N/df) is 0', async () => {
    const { conn, calls } = recordingConn(10);

    await ragHybridSearch(conn, [], QUERY, { lexicalOnly: true }, undefined, 'repo-1');

    const fused = calls.find((c) => c.statement.includes('ident AS ('));
    expect(fused).toBeDefined();
    expect(fused!.params).toContain('{0.000001}');
  });

  it('logs nothing when the statistics read succeeds', async () => {
    const { conn } = fakeStore({ transaction: false, statisticsFail: false });

    await ragHybridSearch(conn, VEC, QUERY);

    expect(h.warn).not.toHaveBeenCalled();
  });
});

describe('ragHybridSearch lexical-only identifier ranker', () => {
  const VEC = [0.1, 0.2, 0.3, 0.4];
  const FILTER = { namespace: 'default', facets: { framework: ['drupal'] }, embedModel: 'model-a' };
  const lexicalOnly = { lexicalOnly: true };
  const mainCall = (calls: Array<{ statement: string; params: unknown[] }>) =>
    calls.find((c) => c.statement.includes('ts_rank_cd'))!;

  it('lets a chunk matched only by an identifier into the lexical-only search', async () => {
    const { conn, calls } = recordingConn();

    await ragHybridSearch(conn, VEC, 'getUserById validation', lexicalOnly);

    const { statement, params } = mainCall(calls);
    expect(statement).toContain('lex AS (');
    expect(statement).toContain('ident AS (');
    expect(statement).toMatch(/SELECT id FROM lex\s+UNION\s+SELECT id FROM ident/);
    expect(statement).toContain('LEFT JOIN ident i ON i.id = c.id');
    expect(params.slice(-4)).toEqual([
      '{"getuserbyid"}',
      `{${Math.log(10)}}`,
      "'getuserbyid'",
      DEFAULT_RAG_SEARCH_CONFIG.candidatePool,
    ]);
    expect(params.filter(Array.isArray)).toEqual([]);
  });

  it('fuses the two rankers and keeps the run-book boost on the sum', async () => {
    const { conn, calls } = recordingConn();

    await ragHybridSearch(conn, VEC, 'getUserById validation', {
      ...lexicalOnly,
      runbookBoost: 1.5,
    });

    const { statement, params } = mainCall(calls);
    expect(statement).toMatch(
      /1\.0 \/ \(\$2 \+ l\.l_rank\)[\s\S]*1\.0 \/ \(\$2 \+ i\.i_rank\)[\s\S]*source_type = 'runbook' THEN \$4::double precision/,
    );
    expect(params.slice(0, 4)).toEqual(['getUserById validation', 60, 8, 1.5]);
  });

  it("sends today's statement unchanged for a prose query", async () => {
    const { conn, calls } = recordingConn();

    await ragHybridSearch(
      conn,
      VEC,
      'how do we validate the form',
      lexicalOnly,
      undefined,
      'repo-1',
    );

    const { statement, params } = mainCall(calls);
    expect(statement).not.toContain('ident AS (');
    expect(statement).not.toContain('lex AS (');
    expect(params).toEqual(['how do we validate the form', 60, 8, 1, 'repo-1']);
  });

  it("sends today's statement unchanged for an identifier the store has never seen", async () => {
    const { conn, calls } = recordingConn(0);

    await ragHybridSearch(conn, VEC, 'getUserById validation', lexicalOnly);

    const { statement, params } = mainCall(calls);
    expect(statement).not.toContain('ident AS (');
    expect(params).toEqual(['getUserById validation', 60, 8, 1]);
  });

  it('applies the facet and repository filters inside the identifier CTE', async () => {
    const { conn, calls } = recordingConn();

    await ragHybridSearch(conn, VEC, 'getUserById validation', lexicalOnly, FILTER, 'repo-1');

    const { statement } = mainCall(calls);
    const ident = statement.slice(statement.indexOf('ident AS ('), statement.indexOf('cand AS ('));
    const lex = statement.slice(statement.indexOf('lex AS ('), statement.indexOf('ident AS ('));
    for (const section of [ident, lex]) {
      expect(section).toContain('repository_id = $');
      expect(section).toContain("source_type <> 'task'");
      expect(section).toMatch(/namespace|facets/);
    }
    expect(statement.match(/repository_id = \$(\d+)/g)!.length).toBe(2);
  });
});

describe('ragHybridSearch identifier ranker prefers a definition', () => {
  const VEC = [0.1, 0.2, 0.3, 0.4];
  const identCte = (statement: string) => statement.match(/ident AS \([\s\S]*?\n {6}\),/)![0];

  it.each([
    ['hybrid', {}],
    ['lexical-only', { lexicalOnly: true }],
  ])('orders the %s ident CTE by the definition flag before the summed IDF', async (_b, cfg) => {
    const { conn, calls } = recordingConn();

    await ragHybridSearch(conn, VEC, 'getUserById validation', cfg);

    const cte = identCte(calls.find((c) => c.statement.includes('ident AS ('))!.statement);
    expect(cte).toMatch(/row_number\(\) OVER \(ORDER BY defines DESC, idf_score DESC, id\)/);
    expect(cte).toMatch(/ORDER BY defines DESC, idf_score DESC\s+LIMIT 3/);
  });

  it.each([
    ['hybrid', {}],
    ['lexical-only', { lexicalOnly: true }],
  ])(
    'compares the section symbol, minus a ~n suffix, with each term on the %s branch',
    async (_b, cfg) => {
      const { conn, calls } = recordingConn();

      await ragHybridSearch(conn, VEC, 'getUserById validation', cfg);

      const main = calls.find((c) => c.statement.includes('ident AS ('))!;
      const cte = identCte(main.statement);
      const termsParam = Number(cte.match(/unnest\(\$(\d+)::text\[\], \$\d+::float8\[\]\)/)![1]);
      expect(cte).toContain(`unnest($${termsParam}::text[]) AS d(term)`);
      expect(cte).toContain("right(lower(split_part(e.section_id, '~', 1)), length(d.term) + 1)");
      expect(cte).toContain("= '-' || d.term) AS defines");
      expect(main.params[termsParam - 1]).toBe('{"getuserbyid"}');
    },
  );

  it.each([
    ['hybrid', {}],
    ['lexical-only', { lexicalOnly: true }],
  ])('leaves a query with no identifier without an ident CTE on the %s branch', async (_b, cfg) => {
    const { conn, calls } = recordingConn();

    await ragHybridSearch(conn, VEC, 'how do we validate the form', cfg);

    const main = calls.find((c) => c.statement.includes('rrf'))!;
    expect(main.statement).not.toContain('ident');
    expect(main.statement).not.toContain('defines');
    expect(main.params).toEqual(
      'lexicalOnly' in cfg
        ? ['how do we validate the form', 60, 8, 1]
        : expect.not.arrayContaining([expect.stringContaining('{')]),
    );
    expect(calls.some((c) => c.statement.includes('AS t(term)'))).toBe(false);
  });
});

const ITERATIVE_SET = 'SET LOCAL hnsw.iterative_scan = relaxed_order';

/** A store that notes where each statement ran: in a transaction, in a savepoint, and in what order. */
function scanStore(opts: { pooled: boolean; setFails?: boolean }) {
  const events: Array<{ statement: string; inTx: boolean; inSavepoint: boolean }> = [];
  let inTx = !opts.pooled;
  let inSavepoint = false;
  const codeRow = {
    source_path: 'src/auth.ts',
    section_id: 's',
    chunk_index: 0,
    source_type: 'code',
    content: 'getUserById',
    dense_sim: 0.8,
    ts_norm: 0,
    hybrid: 0,
    rrf: 0.01,
    id: '1',
  };
  const tx: Record<string, unknown> = {
    unsafe: async (statement: string) => {
      events.push({ statement, inTx, inSavepoint });
      if (statement === ITERATIVE_SET && opts.setFails) {
        throw Object.assign(new Error('unrecognized configuration parameter'), { code: '42704' });
      }
      if (statement.includes('information_schema.columns')) return [{ column_name: 'vector' }];
      if (statement.includes('dense_c') || statement.includes('ANY($2::text[])')) return [codeRow];
      return [];
    },
    savepoint: async (run: (sp: unknown) => unknown) => {
      inSavepoint = true;
      try {
        return await run(tx);
      } finally {
        inSavepoint = false;
      }
    },
  };
  const pg = opts.pooled
    ? {
        unsafe: tx.unsafe,
        begin: async (run: (t: unknown) => unknown) => {
          inTx = true;
          try {
            return await run(tx);
          } finally {
            inTx = false;
          }
        },
      }
    : tx;
  return {
    conn: { mode: 'external', pg, embeddingDimensions: 4, close: async () => {} } as never,
    events,
  };
}

describe('ragHybridSearch global dense reads widen the index scan', () => {
  const VEC = [0.1, 0.2, 0.3, 0.4];
  const FILTER = { namespace: 'default', facets: { framework: ['drupal'] }, embedModel: 'model-a' };
  const QUERY = 'where is the session cookie set';
  const denseIndexes = (events: Array<{ statement: string }>) =>
    events.flatMap((e, i) =>
      e.statement.includes('dense_c') || e.statement.includes('ANY($2::text[])') ? [i] : [],
    );

  it.each([
    ['inside a transaction', false],
    ['outside one, where it opens its own', true],
  ])(
    'sets iterative scan in the transaction before each dense statement %s',
    async (_w, pooled) => {
      const { conn, events } = scanStore({ pooled });

      await ragHybridSearch(conn, VEC, QUERY, {}, FILTER);

      const dense = denseIndexes(events);
      expect(dense).toHaveLength(2);
      for (const at of dense) {
        expect(events[at]!.inTx).toBe(true);
        expect(events[at - 1]).toMatchObject({ statement: ITERATIVE_SET, inTx: true });
        expect(events[at - 1]!.inSavepoint).toBe(true);
      }
    },
  );

  it('still searches when the server refuses the setting', async () => {
    const { conn, events } = scanStore({ pooled: false, setFails: true });

    const hits = await ragHybridSearch(conn, VEC, QUERY, {}, FILTER);

    expect(hits.map((x) => x.sourcePath)).toEqual(['src/auth.ts']);
    expect(denseIndexes(events)).toHaveLength(2);
  });

  it.each([
    ['inside a transaction', false],
    ['outside one', true],
  ])('leaves a per-repo read as it was %s', async (_w, pooled) => {
    const { conn, events } = scanStore({ pooled });

    await ragHybridSearch(conn, VEC, QUERY, {}, undefined, 'repo-1');

    expect(events.map((e) => e.statement)).not.toContain(ITERATIVE_SET);
    expect(events.some((e) => e.inSavepoint)).toBe(false);
    expect(events.every((e) => e.inTx === !pooled)).toBe(true);
  });
});
