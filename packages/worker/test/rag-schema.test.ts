import { describe, expect, it } from 'vitest';
import { ensureRagSchema } from '../src/step-engine/steps/onboarding/_rag-connection.js';
import type { RagConnection } from '@haive/shared/rag';

// Mirrors packages/shared/test/global-kb-schema.test.ts: no live Postgres — a
// fake connection captures the generated SQL and we assert on it. This file
// exists because its absence is why the jsonb branch went without a
// content_tsv GIN index; the global-KB twin had a schema test and did not drift.
function fakeConn(opts: { vectorThrows?: boolean } = {}): {
  conn: RagConnection;
  queries: () => string;
} {
  const captured: string[] = [];
  const pg = ((strings: TemplateStringsArray | string) => {
    // Called as a tag (conn.pg`...`) and as a function (conn.pg(RAG_TABLE)) for
    // identifier interpolation; only the tag form carries SQL worth capturing.
    if (typeof strings === 'string') return strings;
    const q = strings.join('');
    captured.push(q);
    if (opts.vectorThrows && q.includes('CREATE EXTENSION')) {
      return Promise.reject(new Error('pgvector unavailable'));
    }
    return Promise.resolve([]);
  }) as unknown as { unsafe: (q: string, params?: unknown[]) => Promise<unknown[]> };
  pg.unsafe = (q: string) => {
    captured.push(q);
    return Promise.resolve([]);
  };
  const conn = {
    mode: 'internal',
    pg,
    embeddingDimensions: 2560,
    close: async () => {},
  } as unknown as RagConnection;
  return { conn, queries: () => captured.join('\n') };
}

describe('ensureRagSchema', () => {
  it('creates the vector table, the HNSW index and the shared indexes (pgvector path)', async () => {
    const { conn, queries } = fakeConn();
    const res = await ensureRagSchema(conn);
    const sql = queries();

    expect(res.usedPgvector).toBe(true);
    expect(sql).toContain('vector vector(2560) NOT NULL');
    expect(sql).toContain('idx_rag_vector_hnsw');
    expect(sql).toContain('idx_rag_content_tsv');
  });

  it('creates the content_tsv GIN index on the jsonb fallback too', async () => {
    // The regression this file was added for. A store with no vector column is
    // exactly the one ragHybridSearch forces onto lexical-only ranking, so
    // without this index every query it serves is a sequential scan.
    const { conn, queries } = fakeConn({ vectorThrows: true });
    const res = await ensureRagSchema(conn);
    const sql = queries();

    expect(res.usedPgvector).toBe(false);
    expect(sql).toContain('embedding_json jsonb NOT NULL');
    expect(sql).toContain('idx_rag_content_tsv');
    // ...and no vector index, since there is no vector column to build one on.
    expect(sql).not.toContain('idx_rag_vector_hnsw');
  });

  it('creates the same lookup indexes in both variants', async () => {
    const shared = [
      'idx_rag_task_id',
      'idx_rag_repository_id',
      'idx_rag_source_section',
      'idx_rag_source_type',
      'idx_rag_content_tsv',
    ];
    const withVector = fakeConn();
    await ensureRagSchema(withVector.conn);
    const jsonb = fakeConn({ vectorThrows: true });
    await ensureRagSchema(jsonb.conn);

    for (const index of shared) {
      expect(withVector.queries()).toContain(index);
      expect(jsonb.queries()).toContain(index);
    }
  });

  it('installs the identifier-aware tsvector trigger in both variants', async () => {
    for (const opts of [{}, { vectorThrows: true }]) {
      const { conn, queries } = fakeConn(opts);
      await ensureRagSchema(conn);
      const sql = queries();
      expect(sql).toContain('CREATE OR REPLACE FUNCTION update_content_tsv()');
      expect(sql).toContain('array_to_tsvector');
      expect(sql).toContain('trg_content_tsv');
    }
  });
});
