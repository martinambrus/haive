import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureRagSchema } from '../src/step-engine/steps/onboarding/_rag-connection.js';
import { IDENTIFIER_TSV_SENTINEL, identifierTsvSentinelQuery } from '@haive/shared/rag';
import type { RagConnection } from '@haive/shared/rag';

// Mirrors packages/shared/test/global-kb-schema.test.ts: no live Postgres — a
// fake connection captures the generated SQL and we assert on it. This file
// exists because its absence is why the jsonb branch went without a
// content_tsv GIN index; the global-KB twin had a schema test and did not drift.
/** A failure carrying its SQLSTATE, as postgres.js reports one. */
const pgError = (code: string) => Object.assign(new Error(`SQLSTATE ${code}`), { code });
/** The same failure as drizzle rethrows it: no code of its own, the driver error on `cause`. */
const drizzleError = (code: string) =>
  Object.assign(new Error('Failed query: CREATE EXTENSION'), { cause: pgError(code) });

function fakeConn(
  opts: {
    vectorThrows?: string;
    wrapped?: boolean;
    trigger?: 'stale' | 'current';
    fullBatches?: boolean;
  } = {},
): {
  conn: RagConnection;
  queries: () => string;
  statements: () => string[];
  backfillParams: () => unknown[][];
} {
  const backfillParams: unknown[][] = [];
  const captured: string[] = [];
  const pg = ((strings: TemplateStringsArray | string) => {
    // Called as a tag (conn.pg`...`) and as a function (conn.pg(RAG_TABLE)) for
    // identifier interpolation; only the tag form carries SQL worth capturing.
    if (typeof strings === 'string') return strings;
    const q = strings.join('');
    captured.push(q);
    if (opts.vectorThrows && q.includes('CREATE EXTENSION')) {
      return Promise.reject(
        opts.wrapped ? drizzleError(opts.vectorThrows) : pgError(opts.vectorThrows),
      );
    }
    return Promise.resolve([]);
  }) as unknown as { unsafe: (q: string, params?: unknown[]) => Promise<unknown[]> };
  pg.unsafe = (q: string, params?: unknown[]) => {
    captured.push(q);
    if (q.includes('SET content = content')) {
      backfillParams.push(params ?? []);
      return Promise.resolve(Object.assign([], { count: opts.fullBatches ? 2_000 : 0 }));
    }
    if (q.includes('FROM pg_trigger') && opts.trigger) {
      return Promise.resolve([{ stale: opts.trigger === 'stale' }]);
    }
    return Promise.resolve([]);
  };
  (pg as unknown as { begin: unknown }).begin = async (run: (tx: typeof pg) => unknown) => {
    captured.push('BEGIN');
    const result = await run(pg);
    captured.push('COMMIT');
    return result;
  };
  const conn = {
    mode: 'internal',
    pg,
    embeddingDimensions: 2560,
    close: async () => {},
  } as unknown as RagConnection;
  return {
    conn,
    queries: () => captured.join('\n'),
    statements: () => captured,
    backfillParams: () => backfillParams,
  };
}

describe('ensureRagSchema', () => {
  it('runs every CREATE in its own transaction behind the schema lock, so two first ensures do not race', async () => {
    const { conn, statements } = fakeConn();
    await ensureRagSchema(conn);
    const all = statements();
    const creates = all.map((q, i) => ({ q, i })).filter(({ q }) => /^\s*CREATE\b/.test(q));
    expect(creates.length).toBeGreaterThan(0);
    for (const { q, i } of creates) {
      const begin = all.lastIndexOf('BEGIN', i);
      const tx = all.slice(begin, i);
      expect(begin, q).toBeGreaterThanOrEqual(0);
      expect(tx, q).not.toContain('COMMIT');
      expect(tx[1], q).toContain('pg_advisory_xact_lock');
    }
  });

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
    const { conn, queries } = fakeConn({ vectorThrows: '0A000' });
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
    const jsonb = fakeConn({ vectorThrows: '0A000' });
    await ensureRagSchema(jsonb.conn);

    for (const index of shared) {
      expect(withVector.queries()).toContain(index);
      expect(jsonb.queries()).toContain(index);
    }
  });

  it('installs the identifier-aware tsvector trigger in both variants', async () => {
    for (const opts of [{}, { vectorThrows: '0A000' }]) {
      const { conn, queries } = fakeConn(opts);
      await ensureRagSchema(conn);
      const sql = queries();
      expect(sql).toContain('CREATE OR REPLACE FUNCTION update_content_tsv()');
      expect(sql).toContain('array_to_tsvector');
      expect(sql).toContain('trg_content_tsv');
    }
  });

  // A hash-only UPDATE (the forced re-embed) must not recompute every row's tsvector.
  it('creates the tsvector trigger for content writes only, in one transaction', async () => {
    const { conn, queries } = fakeConn();
    await ensureRagSchema(conn);
    const sql = queries();

    expect(sql).toMatch(
      /BEGIN\nSELECT pg_advisory_xact_lock[^\n]*\nSELECT tgattr::text = '' AS stale[^]*?CREATE TRIGGER trg_content_tsv\s+BEFORE INSERT OR UPDATE OF content ON ai_rag_embeddings[^]*?COMMIT/,
    );
    expect(sql).not.toMatch(/BEFORE INSERT OR UPDATE ON/);
  });

  it('replaces a trigger that fires on every update, and leaves a current one alone', async () => {
    const stale = fakeConn({ trigger: 'stale' });
    await ensureRagSchema(stale.conn);
    expect(stale.queries()).toContain(
      'DROP TRIGGER IF EXISTS trg_content_tsv ON ai_rag_embeddings',
    );
    expect(stale.queries()).toContain('UPDATE OF content');

    const current = fakeConn({ trigger: 'current' });
    await ensureRagSchema(current.conn);
    expect(current.queries()).not.toContain('DROP TRIGGER');
    expect(current.queries()).not.toContain('CREATE TRIGGER');
  });

  it.each(['58P01', '42501'])(
    'falls back to jsonb when creating pgvector answers %s',
    async (code) => {
      const { conn, queries } = fakeConn({ vectorThrows: code });

      expect((await ensureRagSchema(conn)).usedPgvector).toBe(false);
      expect(queries()).toContain('embedding_json jsonb NOT NULL');
    },
  );

  it('falls back to jsonb when the pgvector failure arrives wrapped, its code on the cause', async () => {
    const { conn, queries } = fakeConn({ vectorThrows: '0A000', wrapped: true });

    expect((await ensureRagSchema(conn)).usedPgvector).toBe(false);
    expect(queries()).toContain('embedding_json jsonb NOT NULL');
  });

  it.each(['XX000', 'CONNECTION_CLOSED'])(
    'rethrows an extension failure that says nothing about pgvector (%s), and creates nothing',
    async (code) => {
      const { conn, queries } = fakeConn({ vectorThrows: code });

      await expect(ensureRagSchema(conn)).rejects.toMatchObject({ code });
      expect(queries()).not.toContain('CREATE TABLE');
    },
  );
});

describe('the identifier backfill', () => {
  it('matches the stamp as one lexeme and keeps its per-run cap', async () => {
    const { conn, backfillParams } = fakeConn({ fullBatches: true });
    await ensureRagSchema(conn);
    expect(backfillParams()).toHaveLength(20);
    expect(backfillParams()[0]).toEqual([identifierTsvSentinelQuery(), 2_000]);
  });
});

// Needs a server with pgvector; HAIVE_GKB_TEST_DB_URL is any superuser URL on it.
const ADMIN_URL = process.env.HAIVE_GKB_TEST_DB_URL ?? '';
const SCRATCH_DB = `ragident_${process.pid}_${Date.now()}`;

describe.skipIf(!ADMIN_URL)('the identifier backfill against Postgres', () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  let pg: postgres.Sql;
  let conn: RagConnection;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${SCRATCH_DB}`;
    pg = postgres(url.toString(), { max: 1, onnotice: () => {} });
    conn = { mode: 'internal', pg, embeddingDimensions: 8, close: async () => {} } as never;
  });

  afterAll(async () => {
    await pg?.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  const insert = (section: string, content: string) =>
    pg.unsafe(
      `INSERT INTO ai_rag_embeddings (source_type, source_path, section_id, content, vector)
       VALUES ('code', 'a.ts', $1, $2, $3::vector)`,
      [section, content, `[${Array(8).fill(0.1).join(',')}]`],
    );
  const whole = async (section: string) =>
    (
      await pg.unsafe(
        `SELECT content_tsv @@ $1::tsquery AS hit FROM ai_rag_embeddings WHERE section_id = $2`,
        [`'pdf_generator'`, section],
      )
    )[0]!.hit as boolean;
  const xmin = async (section: string) =>
    (
      await pg.unsafe(`SELECT xmin::text AS x FROM ai_rag_embeddings WHERE section_id = $1`, [
        section,
      ])
    )[0]!.x as string;

  it('stamps a legacy row whose prose carries every word of the stamp, and does not touch a stamped row again', async () => {
    await ensureRagSchema(conn);
    const prose = `Notes on ${IDENTIFIER_TSV_SENTINEL} and haive tsv v3 and haivetsvv2 as plain words, then pdf_generator.`;
    await insert('prose', prose);
    await insert('legacy', prose);
    await pg.unsafe(
      `UPDATE ai_rag_embeddings SET content_tsv = to_tsvector('english', content) WHERE section_id = 'legacy'`,
    );

    await ensureRagSchema(conn);
    const before = [await xmin('prose'), await xmin('legacy')];
    await ensureRagSchema(conn);

    expect(await whole('prose')).toBe(true);
    expect(await whole('legacy'), 'the legacy row').toBe(true);
    expect([await xmin('prose'), await xmin('legacy')]).toEqual(before);
  }, 30_000);
});
