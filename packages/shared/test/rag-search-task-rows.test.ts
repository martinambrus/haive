import { describe, expect, it } from 'vitest';
import { ragHybridSearch } from '../src/rag/search.js';
import { TASK_SOURCE_TYPE, type RagConnection } from '../src/rag/connection.js';

/** Capture the SQL `ragHybridSearch` emits. `hasVectorColumn` probes
 *  information_schema first, so `withVector` selects which branch is exercised. */
function capturingConn(withVector: boolean): { conn: RagConnection; statements: string[] } {
  const statements: string[] = [];
  const pg = {
    unsafe: async (q: string) => {
      statements.push(q);
      if (q.includes('information_schema.columns')) {
        return withVector ? [{ column_name: 'vector' }] : [];
      }
      return [];
    },
  };
  return {
    conn: {
      mode: 'internal',
      pg,
      embeddingDimensions: 4,
      close: async () => {},
    } as unknown as RagConnection,
    statements,
  };
}

const EXCLUSION = `source_type <> '${TASK_SOURCE_TYPE}'`;

describe('ragHybridSearch excludes the effort estimator task rows', () => {
  it('filters them out of the dense + lexical branch', async () => {
    const { conn, statements } = capturingConn(true);

    await ragHybridSearch(conn, [0.1, 0.2, 0.3, 0.4], 'pdf_generator row', {}, undefined, 'repo-1');

    const search = statements.find((s) => s.includes('dense_c'));
    expect(search).toBeDefined();
    // Present in the dense candidate CTE and in the lexical one, or a task row still
    // enters the fusion through whichever half was left unfiltered.
    expect(search!.split(EXCLUSION).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('filters them out of the lexical-only branch', async () => {
    const { conn, statements } = capturingConn(false);

    await ragHybridSearch(conn, [], 'pdf_generator row', {}, undefined, 'repo-1');

    const search = statements.find((s) => s.includes('ts_rank_cd'));
    expect(search).toBeDefined();
    expect(search).toContain(EXCLUSION);
  });

  it('filters them even with no repository scope (the global KB shape)', async () => {
    const { conn, statements } = capturingConn(true);

    await ragHybridSearch(conn, [0.1, 0.2, 0.3, 0.4], 'anything', {});

    const search = statements.find((s) => s.includes('dense_c'));
    expect(search).toContain(EXCLUSION);
  });
});
