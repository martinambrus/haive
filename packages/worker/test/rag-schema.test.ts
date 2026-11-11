import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  logger: { child: () => ({ warn: logged.warn, info: () => {} }) },
}));
import { ensureRagSchema } from '../src/step-engine/steps/onboarding/_rag-connection.js';
import {
  ACCENT_TSV_SENTINEL,
  IDENTIFIER_TSV_SENTINEL,
  identifierTsvSentinelQuery,
} from '@haive/shared/rag';
import type { RagConnection } from '@haive/shared/rag';
import { ragHybridSearch } from '@haive/shared/rag';

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
    unaccentThrows?: string;
  } = {},
): {
  conn: RagConnection;
  queries: () => string;
  statements: () => string[];
  backfillParams: () => unknown[][];
} {
  const backfillParams: unknown[][] = [];
  const captured: string[] = [];
  const configs = new Set<string>();
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
    if (q.includes('CREATE EXTENSION IF NOT EXISTS unaccent') && opts.unaccentThrows) {
      return Promise.reject(pgError(opts.unaccentThrows));
    }
    if (q.startsWith('SELECT c.oid AS config')) {
      const name = /cfgname = '([^']+)'/.exec(q)![1]!;
      return Promise.resolve([{ config: configs.has(name) ? name : null }]);
    }
    if (q.includes('CREATE TEXT SEARCH CONFIGURATION')) {
      configs.add(/CONFIGURATION ([^\s]+)/.exec(q)![1]!);
      return Promise.resolve(Object.assign([], { command: 'CREATE' }));
    }
    if (q.includes('AS dictionary')) return Promise.resolve([{ dictionary: 'public.unaccent' }]);
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
  it.each(['42501', '0A000', '58P01'])(
    'fails open once when unaccent is unavailable (%s)',
    async (code) => {
      logged.warn.mockClear();
      const { conn, queries } = fakeConn({ unaccentThrows: code });
      await expect(ensureRagSchema(conn)).resolves.toMatchObject({ usedPgvector: true });
      await expect(ensureRagSchema(conn)).resolves.toMatchObject({ usedPgvector: true });
      expect(queries()).toContain('CREATE TEXT SEARCH CONFIGURATION haive_english_verbatim_v1');
      expect(queries()).not.toContain('CREATE TEXT SEARCH CONFIGURATION haive_english_unaccent_v1');
      expect(logged.warn).toHaveBeenCalledTimes(1);
      expect(logged.warn.mock.calls[0]![0]).toMatchObject({ err: { code } });
    },
  );

  it('ensures unaccent in the RAG store and uses a recorded text-search configuration', async () => {
    const { conn, queries } = fakeConn();
    await ensureRagSchema(conn);
    expect(queries()).toContain('CREATE EXTENSION IF NOT EXISTS unaccent');
    expect(queries()).toContain('CREATE TEXT SEARCH CONFIGURATION haive_english_unaccent_v1');
    expect(queries()).toContain('pg_catalog.english_stem');
    expect(queries()).toContain("'haive_english_unaccent_v1'");
  });

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

  const search = async (query: string, lexicalOnly = true) =>
    (
      await ragHybridSearch(conn, Array(8).fill(0.1), query, { lexicalOnly, knowledgeReserve: 0 })
    ).map((hit) => hit.sectionId);

  it('matches a numbered term with or without its accents', async () => {
    await ensureRagSchema(conn);
    await insert('numbered-accent', 'kotolňa2 runs');
    await insert('numbered-plain', 'kotolna-2b runs');
    try {
      for (const query of ['kotolna2', 'kotolňa2'])
        expect(await search(query)).toContain('numbered-accent');
      for (const query of ['kotolňa-2b', 'kotolna-2b'])
        expect(await search(query)).toContain('numbered-plain');
    } finally {
      await pg.unsafe(
        `DELETE FROM ai_rag_embeddings WHERE section_id IN ('numbered-accent', 'numbered-plain')`,
      );
    }
  }, 30_000);

  it('ensures, indexes, searches and backfills a quoted mixed-case schema', async () => {
    await ensureRagSchema(conn);
    await pg.unsafe('CREATE SCHEMA "Haive"');
    await pg.unsafe('SET search_path TO "Haive", public');
    try {
      await ensureRagSchema(conn);
      await insert('mixed-new', 'kotolňa runs');
      await insert('mixed-legacy', 'kotolňa');
      await pg.unsafe(
        `UPDATE ai_rag_embeddings SET content_tsv = to_tsvector('english', content)
        || array_to_tsvector(ARRAY[$1]) WHERE section_id = 'mixed-legacy'`,
        [IDENTIFIER_TSV_SENTINEL],
      );
      expect(await search('kotolna')).toEqual(['mixed-new']);
      const before = await xmin('mixed-legacy');
      await ensureRagSchema(conn);
      for (const query of ['kotolna', 'kotolňa']) {
        expect(await search(query)).toEqual(expect.arrayContaining(['mixed-new', 'mixed-legacy']));
      }
      expect(await xmin('mixed-legacy')).not.toBe(before);
      const after = await xmin('mixed-legacy');
      await ensureRagSchema(conn);
      expect(await xmin('mixed-legacy')).toBe(after);
    } finally {
      await pg.unsafe('SET search_path TO public');
      await pg.unsafe('DROP SCHEMA "Haive" CASCADE');
    }
  }, 30_000);

  it.each(['public', 'custom', 'dictionary-refused'])(
    'keeps an external %s store searchable without extension privileges, warns once, and upgrades when restored',
    async (schema) => {
      const dbName = `${SCRATCH_DB}_fallback_${schema}`;
      const roleName = `${SCRATCH_DB}_role_${schema}`;
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
      await admin.unsafe(`CREATE ROLE "${roleName}"`);
      const url = new URL(ADMIN_URL);
      url.pathname = `/${dbName}`;
      const external = postgres(url.toString(), { max: 1, onnotice: () => {} });
      try {
        await external.unsafe('CREATE EXTENSION vector');
        if (schema === 'custom') {
          await external.unsafe(`CREATE SCHEMA custom AUTHORIZATION "${roleName}"`);
          await external.unsafe('SET search_path = custom, public');
        } else {
          await external.unsafe(`GRANT CREATE, USAGE ON SCHEMA public TO "${roleName}"`);
        }
        if (schema === 'dictionary-refused') {
          await external.unsafe('CREATE SCHEMA extensions');
          await external.unsafe('CREATE EXTENSION unaccent WITH SCHEMA extensions');
        }
        await external.unsafe(`SET ROLE "${roleName}"`);
        const extConn: RagConnection = {
          mode: 'external',
          pg: external,
          embeddingDimensions: 8,
          close: async () => {},
        };
        logged.warn.mockClear();
        await ensureRagSchema(extConn);
        await external.unsafe(
          `INSERT INTO ai_rag_embeddings
        (source_type, source_path, section_id, content, vector)
        VALUES ('code', 'a.ts', 'verbatim', 'kotolňa čerpadlo runs', $1::vector)`,
          [`[${Array(8).fill(0.1).join(',')}]`],
        );
        await ensureRagSchema(extConn);
        expect(logged.warn).toHaveBeenCalledTimes(1);
        expect(logged.warn.mock.calls[0]![0]).toMatchObject({ err: { code: '42501' } });
        const lookup = async (query: string) =>
          (await ragHybridSearch(extConn, [], query, { lexicalOnly: true })).map(
            (hit) => hit.sectionId,
          );
        expect(await lookup('kotolňa')).toEqual(['verbatim']);
        expect(await lookup('kotolna')).toEqual([]);
        expect(await lookup('running')).toEqual(['verbatim']);
        await external.unsafe('RESET ROLE');
        if (schema === 'custom') {
          await external.unsafe('CREATE SCHEMA extensions');
          await external.unsafe('CREATE EXTENSION unaccent WITH SCHEMA extensions');
        }
        await ensureRagSchema(extConn);
        expect(await lookup('kotolna')).toEqual(['verbatim']);
        expect(await lookup('čerpadlo')).toEqual(['verbatim']);
      } finally {
        await external.end({ timeout: 5 });
        await admin.unsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`);
        await admin.unsafe(`DROP ROLE "${roleName}"`);
      }
    },
    30_000,
  );

  it('finds Slovak prose in either spelling and preserves English stemming in both search branches', async () => {
    await ensureRagSchema(conn);
    await insert('accented', 'kotolňa čerpadlo pdf_generator runs');
    await insert('plain', 'kotolna cerpadlo');
    for (const lexicalOnly of [true, false]) {
      for (const query of ['kotolna', 'kotolňa', 'cerpadlo', 'čerpadlo']) {
        // A high dense floor ensures the hybrid case must earn its lexical match too.
        const hits = await ragHybridSearch(conn, Array(8).fill(-0.1), query, {
          lexicalOnly,
          denseFloor: 1,
          codeDenseFloor: 1,
          knowledgeReserve: 0,
        });
        expect(
          hits.map((hit) => hit.sectionId),
          query,
        ).toEqual(expect.arrayContaining(['accented', 'plain']));
      }
      for (const query of ['running', 'cerpadlo pdf_generator', 'čerpadlo pdf_generator']) {
        expect(await search(query, lexicalOnly)).toContain('accented');
      }
    }
  }, 30_000);

  it('backfills pre-existing vectors without content/hash edits and is a no-op on re-run', async () => {
    await ensureRagSchema(conn);
    await insert('accent-legacy', 'kotolňa čerpadlo');
    await pg.unsafe(
      `UPDATE ai_rag_embeddings SET content_tsv = to_tsvector('english', content)
      || array_to_tsvector(ARRAY[$1]) WHERE section_id = 'accent-legacy'`,
      [IDENTIFIER_TSV_SENTINEL],
    );
    expect(await search('kotolna')).not.toContain('accent-legacy');
    const before = await xmin('accent-legacy');
    await ensureRagSchema(conn);
    expect(await search('kotolna')).toContain('accent-legacy');
    expect(await xmin('accent-legacy')).not.toBe(before);
    const upgraded = await xmin('accent-legacy');
    await ensureRagSchema(conn);
    expect(await xmin('accent-legacy')).toBe(upgraded);
  }, 30_000);

  it('resumes after an interrupted batch without rewriting completed rows', async () => {
    await ensureRagSchema(conn);
    await pg.unsafe(
      `INSERT INTO ai_rag_embeddings
      (source_type, source_path, section_id, content, vector)
      SELECT 'code', 'resume.ts', 'resume-' || n, 'kotolňa čerpadlo', $1::vector
      FROM generate_series(1, 2001) n`,
      [`[${Array(8).fill(0.1).join(',')}]`],
    );
    await pg.unsafe(
      `UPDATE ai_rag_embeddings SET content_tsv = to_tsvector('english', content)
      || array_to_tsvector(ARRAY[$1]) WHERE source_path = 'resume.ts'`,
      [IDENTIFIER_TSV_SENTINEL],
    );
    let batches = 0;
    const interrupted = new Proxy(pg, {
      get(target, key) {
        if (key === 'unsafe')
          return (query: string, params: never) => {
            if (query.includes('SET content = content') && ++batches === 2)
              throw new Error('interrupted fixture');
            return target.unsafe(query, params);
          };
        return Reflect.get(target, key);
      },
    });
    await expect(ensureRagSchema({ ...conn, pg: interrupted })).resolves.toBeDefined();
    const upgraded = await pg.unsafe(
      `SELECT id, xmin::text AS version FROM ai_rag_embeddings
      WHERE source_path = 'resume.ts' AND content_tsv @@ $1::tsquery`,
      [`'${ACCENT_TSV_SENTINEL}'`],
    );
    expect(upgraded).toHaveLength(2000);
    await ensureRagSchema(conn);
    const all = await pg.unsafe(
      `SELECT id, xmin::text AS version, content_tsv @@ $1::tsquery AS stamped
      FROM ai_rag_embeddings WHERE source_path = 'resume.ts'`,
      [`'${ACCENT_TSV_SENTINEL}'`],
    );
    expect(all).toHaveLength(2001);
    expect(all.every((row) => row.stamped)).toBe(true);
    const versions = new Map(all.map((row) => [row.id, row.version]));
    for (const row of upgraded) expect(versions.get(row.id)).toBe(row.version);
    await pg.unsafe(`DELETE FROM ai_rag_embeddings WHERE source_path = 'resume.ts'`);
  }, 30_000);

  it('does not confuse prose containing the accent stamp with a normalized vector', async () => {
    const rows = await pg.unsafe(`SELECT to_tsvector('english', $1) @@ $2::tsquery AS stamped`, [
      ACCENT_TSV_SENTINEL,
      `'${ACCENT_TSV_SENTINEL}'`,
    ]);
    expect(rows[0]!.stamped).toBe(false);
  });

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
