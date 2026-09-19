import { describe, expect, it } from 'vitest';
import { ensureGlobalKbSchema } from '../src/global-kb/ensure-schema.js';
import { orphanFacetMajorSql, trimFacetValueSql } from '../src/global-kb/schema.js';
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
  const tag = (strings: TemplateStringsArray) => {
    const q = strings.join('');
    captured.push(q);
    if (opts.vectorThrows && q.includes('CREATE EXTENSION')) {
      return Promise.reject(new Error('pgvector unavailable'));
    }
    return Promise.resolve([]);
  };
  // A stand-in for the postgres.js tag: complete before the cast, so the cast is the
  // only place the fake is told it is the real thing.
  const pg = Object.assign(tag, {
    unsafe: (q: string) => {
      captured.push(q);
      return Promise.resolve([]);
    },
  }) as unknown as GlobalKbConnection['pg'];
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
    // Facet filter support: the broad default-jsonb_ops GIN, and NO per-dimension
    // expression GIN — `buildFacetClause`'s leading `NOT (facets ? dim)` makes the
    // whole OR unindexable, so those six only ever cost writes (measured: with
    // enable_seqscan off, Postgres still refused an index path for an INDEXED
    // dimension). They are dropped on every ensure so an old install converges.
    expect(sql).toContain('USING GIN (facets)');
    expect(sql).not.toContain("USING GIN ((facets->'framework'))");
    expect(sql).toContain('DROP INDEX IF EXISTS idx_global_rag_facets_framework');
    // Only the index NAME was ever lowercased; the JSONB key is camelCase, which is
    // exactly what a hand-written DROP list gets wrong.
    expect(sql).toContain('DROP INDEX IF EXISTS idx_global_rag_facets_phpmajor');
    expect(sql).not.toContain('idx_global_rag_facets_phpMajor');
    // tsvector trigger.
    expect(sql).toContain('trg_global_content_tsv');
  });

  it('never lets the facet backfill store a JSON null', async () => {
    const { conn, queries } = fakeConn();
    await ensureGlobalKbSchema(conn);
    const sql = queries();

    // `jsonb_agg` over zero rows is SQL NULL, so aggregating an EMPTY dimension straight into
    // `jsonb_object_agg` rewrites it as JSON `null`. Retrieval then calls
    // `jsonb_array_length(facets->'<dim>')` on it and raises `cannot get array length of a
    // scalar`, which fails the WHOLE query — MEASURED, a two-row set with one corrupt row
    // returned neither row. Empty dimensions are dropped instead, which costs no meaning
    // because absent and empty are the same claim to both filters.
    expect(sql).toContain('WHERE a.arr IS NOT NULL');
    expect(sql).toContain("CASE WHEN jsonb_typeof(kv.value) = 'array'");
    // The predicate admits a non-array value, so the pass REPAIRS a row an earlier version of
    // this migration wrote rather than needing a migration of its own.
    expect(sql).toContain("WHERE jsonb_typeof(kv.value) <> 'array'");
  });

  it("backfills through the write path's rule, not an approximation of it", async () => {
    const { conn, queries } = fakeConn();
    await ensureGlobalKbSchema(conn);
    const sql = queries();

    // `lower(v)` alone left three classes of legacy row permanently unreachable: `PostgreSQL`
    // was rewritten to `postgresql`, which no project reports; an already-lowercase
    // `postgresql` was never selected; and a padded ` drupal ` matched neither the predicate
    // (`lower(v)` equals it) nor `?|` (which does not trim). The rule is generated from the same
    // alias table `normalizeFacets` reads, so the two engines cannot drift.
    expect(sql).toContain(`lower(${trimFacetValueSql('v')})`);
    expect(sql).toContain(
      `WHEN kv.key = 'database' AND lower(${trimFacetValueSql('v')}) = 'postgresql'`,
    );
    expect(sql).toContain(`WHERE ${trimFacetValueSql('v')} <> ''`);
    // The predicate is "differs from its canonical form", which subsumes case, padding and
    // aliases — the case-only test must NOT come back.
    expect(sql).not.toContain('v <> lower(v)');
  });

  // The cleaning drops a blank parent, so without the relational rule it MANUFACTURED an orphan
  // major: a legacy `{"framework":[""],"frameworkMajor":["11"]}` came out as a rule matching every
  // framework's v11. It has to sit in BOTH places — the aggregation, so a selected row drops the
  // major, and the predicate, so an already-clean `{"frameworkMajor":["11"]}` is selected at all —
  // and on BOTH tables, since retrieval reads the chunk's own copy of the facets.
  it("applies the write path's parent/major rule in the facet backfill", async () => {
    const { conn, queries } = fakeConn();
    await ensureGlobalKbSchema(conn);
    const sql = queries();
    const orphan = orphanFacetMajorSql('kv.key', 't.facets');
    const count = (needle: string): number => sql.split(needle).length - 1;
    expect(count(`WHERE a.arr IS NOT NULL AND NOT ${orphan}`)).toBe(2);
    expect(count(`OR ${orphan}`)).toBe(2);
  });

  // `jsonb_typeof(x) <> 'array' OR EXISTS (... jsonb_array_elements_text(x) ...)` reads like a guard
  // and is not one: Postgres does not promise OR evaluation order, and the expansion raises on a
  // scalar. Pinned as an invariant over ALL emitted SQL rather than one site, so a new unguarded
  // expansion anywhere in the ensure fails here.
  it('guards every jsonb_array_elements_text with a CASE', async () => {
    const { conn, queries } = fakeConn();
    await ensureGlobalKbSchema(conn);
    const firstTokens = [...queries().matchAll(/jsonb_array_elements_text\(\s*(\S+)/g)].map(
      (m) => m[1],
    );
    expect(firstTokens.length).toBeGreaterThan(0);
    expect(firstTokens.filter((t) => t !== 'CASE')).toEqual([]);
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
