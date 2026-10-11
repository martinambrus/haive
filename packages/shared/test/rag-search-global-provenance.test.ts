import { describe, expect, it } from 'vitest';
import { ragHybridSearch, type RagFacetFilter } from '../src/rag/search.js';
import type { RagConnection } from '../src/rag/connection.js';

function capturingConn(): { conn: RagConnection; statements: string[] } {
  const statements: string[] = [];
  const pg = {
    unsafe: async (q: string) => {
      statements.push(q);
      return q.includes('information_schema.columns') ? [{ column_name: 'vector' }] : [];
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

const FILTER: RagFacetFilter = { namespace: 'house', facets: {} };
const QV = [0.1, 0.2, 0.3, 0.4];
const denseCte = (sql: string): string =>
  sql.slice(sql.indexOf('dense_c AS'), sql.indexOf('dense AS'));

describe('ragHybridSearch ranks only model vectors in the global dense half', () => {
  it('requires embed_kind = model in dense_c when a facet filter is set', async () => {
    const { conn, statements } = capturingConn();
    await ragHybridSearch(conn, QV, 'anything', {}, FILTER);

    const search = statements.find((s) => s.includes('dense_c'))!;
    expect(denseCte(search)).toContain("embed_kind = 'model'");
  });

  it('leaves the lexical candidates alone, so a hashed row stays findable by words', async () => {
    const { conn, statements } = capturingConn();
    await ragHybridSearch(conn, QV, 'anything', {}, FILTER);

    const search = statements.find((s) => s.includes('dense_c'))!;
    const lex = search.slice(search.indexOf('lex AS'), search.indexOf('cand AS'));
    expect(lex).not.toContain('embed_kind');
  });

  it('does not touch the local statement', async () => {
    for (const repo of ['repo-1', undefined]) {
      const { conn, statements } = capturingConn();
      await ragHybridSearch(conn, QV, 'anything', {}, undefined, repo);
      const search = statements.find((s) => s.includes('dense_c'))!;
      expect(search).not.toContain('embed_kind');
      expect(search).toContain(
        'COALESCE(d.dense_sim, 1 - (e.vector <=> (SELECT qv FROM q))) AS dense_sim',
      );
    }
  });
});

describe('fetchKnowledgeCandidates on the global path', () => {
  it('requires embed_kind = model, and the local candidate query does not', async () => {
    const run = async (filter: RagFacetFilter | undefined, repo: string | undefined) => {
      const statements: string[] = [];
      const pg = {
        unsafe: async (q: string) => {
          statements.push(q);
          if (q.includes('information_schema.columns')) return [{ column_name: 'vector' }];
          if (q.includes('dense_c')) {
            return [
              {
                source_path: 'p',
                section_id: 's',
                chunk_index: 0,
                source_type: 'code',
                content: 'c',
                id: 1,
                dense_sim: 0.9,
                ts_norm: 0,
                hybrid: 0,
                rrf: 1,
              },
            ];
          }
          return [];
        },
      };
      const conn = {
        mode: 'internal',
        pg,
        embeddingDimensions: 4,
        close: async () => {},
      } as unknown as RagConnection;
      await ragHybridSearch(conn, QV, 'anything', {}, filter, repo);
      return statements.find((s) => s.includes('source_type = ANY'))!;
    };

    expect(await run(FILTER, undefined)).toContain("embed_kind = 'model'");
    expect(await run(undefined, 'repo-1')).not.toContain('embed_kind');
  });
});
