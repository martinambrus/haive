import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../src/logger/index.js', () => ({
  logger: { child: () => ({ warn: h.warn }), info: () => {}, warn: () => {}, error: () => {} },
}));

import { ragHybridSearch } from '../src/rag/search.js';

const EF_SET = 'SET LOCAL hnsw.ef_search = 200';
const COST_SET = 'SET LOCAL cpu_operator_cost = 0.1';
const ITERATIVE_SET = 'SET LOCAL hnsw.iterative_scan = relaxed_order';
const VEC = [0.1, 0.2, 0.3, 0.4];
const FILTER = { namespace: 'default', facets: {}, embedModel: 'model-a' };

interface Event {
  statement: string;
  inTx: boolean;
  inSavepoint: boolean;
}

function store(opts: { pooled: boolean; failing?: string }) {
  const events: Event[] = [];
  let inTx = !opts.pooled;
  let inSavepoint = false;
  const tx: Record<string, unknown> = {
    unsafe: async (statement: string) => {
      events.push({ statement, inTx, inSavepoint });
      if (statement === opts.failing) {
        throw Object.assign(new Error('unrecognized configuration parameter'), { code: '42704' });
      }
      if (statement.includes('information_schema.columns')) return [{ column_name: 'vector' }];
      if (statement.includes('current_setting')) return [{ s0: null, s1: '0.0025', s2: 'off' }];
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
            id: '1',
          },
        ];
      }
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

const statements = (events: Event[]): string[] => events.map((e) => e.statement);
const mainIndex = (events: Event[]): number =>
  events.findIndex((e) => e.statement.includes('dense_c'));

describe('ragHybridSearch per-repository dense read widens the index search', () => {
  beforeEach(() => h.warn.mockClear());

  it.each([
    ['inside a transaction', false],
    ['outside one, where it opens its own', true],
  ])(
    'sets ef_search, the cost and iterative scan in a savepoint before the dense statement %s',
    async (_w, pooled) => {
      const { conn, events } = store({ pooled });

      await ragHybridSearch(conn, VEC, 'where is the session cookie set', {}, undefined, 'repo-1');

      const at = mainIndex(events);
      expect(events[at]!.inTx).toBe(true);
      expect(events[at - 3]).toMatchObject({ statement: EF_SET, inTx: true, inSavepoint: true });
      expect(events[at - 2]).toMatchObject({ statement: COST_SET, inTx: true, inSavepoint: true });
      expect(events[at - 1]).toMatchObject({
        statement: ITERATIVE_SET,
        inTx: true,
        inSavepoint: true,
      });
    },
  );

  it('restores the prior settings right after the dense statement, inside the caller transaction', async () => {
    const { conn, events } = store({ pooled: false });

    await ragHybridSearch(conn, VEC, 'where is the session cookie set', {}, undefined, 'repo-1');

    const at = mainIndex(events);
    expect(statements(events).slice(at + 1, at + 4)).toEqual([
      'SET LOCAL hnsw.ef_search TO DEFAULT',
      'SELECT set_config($1, $2, true)',
      'SELECT set_config($1, $2, true)',
    ]);
  });

  it('still searches, and warns, when the server refuses the setting', async () => {
    for (const failing of [EF_SET, COST_SET, ITERATIVE_SET]) {
      h.warn.mockClear();
      const { conn, events } = store({ pooled: false, failing });

      const hits = await ragHybridSearch(
        conn,
        VEC,
        'where is the session cookie set',
        {},
        undefined,
        'repo-1',
      );

      expect(hits.map((x) => x.sourcePath)).toEqual(['src/auth.ts']);
      expect(mainIndex(events)).toBeGreaterThan(-1);
      expect(h.warn).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves the global read to iterative scan alone', async () => {
    const { conn, events } = store({ pooled: false });

    await ragHybridSearch(conn, VEC, 'where is the session cookie set', {}, FILTER);

    expect(statements(events)).toContain(ITERATIVE_SET);
    expect(statements(events)).not.toContain(EF_SET);
    expect(statements(events)).not.toContain(COST_SET);
  });

  it('leaves a read with neither a repository nor a filter untouched', async () => {
    const { conn, events } = store({ pooled: true });

    await ragHybridSearch(conn, VEC, 'where is the session cookie set');

    expect(statements(events)).not.toContain(EF_SET);
    expect(events.every((e) => !e.inTx && !e.inSavepoint)).toBe(true);
  });
});
