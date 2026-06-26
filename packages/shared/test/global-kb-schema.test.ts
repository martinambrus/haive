import { describe, expect, it } from 'vitest';
import { ensureGlobalKbSchema } from '../src/global-kb/ensure-schema.js';
import type { GlobalKbConnection } from '../src/global-kb/connection.js';

// Mirrors the repo's RAG tests (e.g. worker insertChunk upsert SQL): no live
// Postgres — a fake connection captures the generated SQL and we assert on it.
// The full insert/select round-trip is exercised against the running stack by
// Slice 2/3.
function fakeConn(opts: { vectorThrows?: boolean } = {}): {
  conn: GlobalKbConnection;
  queries: () => string;
} {
  const captured: string[] = [];
  const pg = ((strings: TemplateStringsArray) => {
    const q = strings.join('');
    captured.push(q);
    if (opts.vectorThrows && q.includes('CREATE EXTENSION')) {
      return Promise.reject(new Error('pgvector unavailable'));
    }
    return Promise.resolve([]);
  }) as unknown as GlobalKbConnection['pg'] & { unsafe: (q: string) => Promise<unknown[]> };
  pg.unsafe = (q: string) => {
    captured.push(q);
    return Promise.resolve([]);
  };
  const conn = {
    mode: 'internal',
    pg,
    namespace: 'default',
    embeddingDimensions: 2560,
    ollamaUrl: null,
    embedModel: null,
    close: async () => {},
  } as GlobalKbConnection;
  return { conn, queries: () => captured.join('\n') };
}

describe('ensureGlobalKbSchema', () => {
  it('creates both tables, the upsert key, facet indexes, checks, and trigger (pgvector path)', async () => {
    const { conn, queries } = fakeConn();
    const res = await ensureGlobalKbSchema(conn);
    const sql = queries();

    expect(res.usedPgvector).toBe(true);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS global_kb_entries');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ai_rag_embeddings');
    expect(sql).toContain('vector(2560)');
    // Upsert key the sync job's ON CONFLICT targets.
    expect(sql).toContain('uq_global_rag_ns_entry_section_chunk');
    expect(sql).toContain('(namespace, entry_id, section_id, chunk_index)');
    // Enum-like guards.
    expect(sql).toContain(
      "category IN ('general','tech_pattern','anti_pattern','best_practice','quick_reference')",
    );
    expect(sql).toContain(
      "status IN ('skeleton','enriching','draft','active','archived','failed')",
    );
    // Facet filter support: broad default-jsonb_ops GIN + per-array expression GIN.
    expect(sql).toContain('USING GIN (facets)');
    expect(sql).toContain("USING GIN ((facets->'framework'))");
    // JSONB key casing must be preserved (facet keys are camelCase); only the
    // index NAME is lowercased.
    expect(sql).toContain("USING GIN ((facets->'phpMajor'))");
    expect(sql).toContain('idx_global_rag_facets_phpmajor');
    // tsvector trigger.
    expect(sql).toContain('trg_global_content_tsv');
  });

  it('falls back to jsonb embeddings when pgvector is unavailable', async () => {
    const { conn, queries } = fakeConn({ vectorThrows: true });
    const res = await ensureGlobalKbSchema(conn);
    const sql = queries();

    expect(res.usedPgvector).toBe(false);
    expect(sql).toContain('embedding_json jsonb NOT NULL');
    expect(sql).not.toContain('vector(2560)');
    // Upsert key + facet indexes still created on the fallback table.
    expect(sql).toContain('uq_global_rag_ns_entry_section_chunk');
    expect(sql).toContain('USING GIN (facets)');
  });
});
