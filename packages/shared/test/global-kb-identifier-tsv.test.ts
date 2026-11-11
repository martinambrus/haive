import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backfillGlobalIdentifierTsv,
  ensureGlobalKbSchema,
} from '../src/global-kb/ensure-schema.js';
import { IDENTIFIER_TSV_SENTINEL } from '../src/rag/identifiers.js';
import { ragHybridSearch } from '../src/rag/search.js';

// Needs a server with pgvector. HAIVE_GKB_TEST_DB_URL is any superuser URL on it,
// and the test works in a scratch database it creates and drops.
const ADMIN_URL = process.env.HAIVE_GKB_TEST_DB_URL ?? '';
const SCRATCH_DB = `gkbident_${process.pid}_${Date.now()}`;
const DIMS = 8;
const SENTINEL_QUERY = `'${IDENTIFIER_TSV_SENTINEL}'`;

const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

describe.skipIf(!ADMIN_URL)('identifier lexemes in the global KB store', () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  let pg: postgres.Sql;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
    pg = postgres(withDatabase(ADMIN_URL, SCRATCH_DB), { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await pg?.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  const ensure = () => ensureGlobalKbSchema({ pg, embeddingDimensions: DIMS });
  const insert = (section: string, content: string) =>
    pg.unsafe(
      `INSERT INTO ai_rag_embeddings (namespace, entry_id, source_path, section_id, content, vector, embed_kind)
       VALUES ('default', gen_random_uuid(), 'kb', $1, $2, $3::vector, 'model')`,
      [section, content, `[${Array(DIMS).fill(0.1).join(',')}]`],
    );
  const xmins = async () =>
    (await pg.unsafe(`SELECT xmin::text AS x FROM ai_rag_embeddings ORDER BY section_id`)).map(
      (r) => r.x as string,
    );
  const matches = async (query: string) =>
    (
      await pg.unsafe(
        `SELECT section_id FROM ai_rag_embeddings WHERE content_tsv @@ $1::tsquery ORDER BY section_id`,
        [query],
      )
    ).map((r) => r.section_id as string);

  it('normalizes Slovak prose for new and pre-existing global chunks, keeping English stemming', async () => {
    await ensure();
    await insert('accent-new', 'kotolňa čerpadlo runs');
    await insert('accent-plain', 'kotolna cerpadlo');
    await insert('accent-legacy', 'kotolňa čerpadlo');
    await pg.unsafe(
      `UPDATE ai_rag_embeddings SET content_tsv = to_tsvector('english', content)
      || array_to_tsvector(ARRAY[$1]) WHERE section_id = 'accent-legacy'`,
      [IDENTIFIER_TSV_SENTINEL],
    );
    await ensure();
    const conn = {
      pg,
      mode: 'internal',
      embeddingDimensions: DIMS,
      close: async () => {},
    } as const;
    for (const query of ['kotolna', 'kotolňa', 'cerpadlo', 'čerpadlo']) {
      const hits = await ragHybridSearch(conn, [], query, { lexicalOnly: true });
      expect(
        hits.map((hit) => hit.sectionId),
        query,
      ).toEqual(expect.arrayContaining(['accent-new', 'accent-plain', 'accent-legacy']));
    }
    expect(
      (await ragHybridSearch(conn, [], 'running', { lexicalOnly: true })).map(
        (hit) => hit.sectionId,
      ),
    ).toContain('accent-new');
    const before = await xmins();
    await ensure();
    expect(await xmins()).toEqual(before);
  }, 30_000);

  it('ensures, indexes, searches and backfills a quoted mixed-case global schema', async () => {
    await ensure();
    await pg.unsafe('CREATE SCHEMA "Haive"');
    await pg.unsafe('SET search_path TO "Haive", public');
    try {
      await ensure();
      await insert('mixed-new', 'kotolňa runs');
      await insert('mixed-legacy', 'kotolňa');
      await pg.unsafe(
        `UPDATE ai_rag_embeddings SET content_tsv = to_tsvector('english', content)
        || array_to_tsvector(ARRAY[$1]) WHERE section_id = 'mixed-legacy'`,
        [IDENTIFIER_TSV_SENTINEL],
      );
      const conn = {
        pg,
        mode: 'internal',
        embeddingDimensions: DIMS,
        close: async () => {},
      } as const;
      const search = async (query: string) =>
        (await ragHybridSearch(conn, [], query, { lexicalOnly: true })).map((hit) => hit.sectionId);
      expect(await search('kotolna')).toEqual(['mixed-new']);
      const before = await xmins();
      await ensure();
      for (const query of ['kotolna', 'kotolňa']) {
        expect(await search(query)).toEqual(expect.arrayContaining(['mixed-new', 'mixed-legacy']));
      }
      expect(await xmins()).not.toEqual(before);
      const after = await xmins();
      await ensure();
      expect(await xmins()).toEqual(after);
    } finally {
      await pg.unsafe('SET search_path TO public');
      await pg.unsafe('DROP SCHEMA "Haive" CASCADE');
    }
  }, 30_000);

  it('leaves no fallback marker after a real config timeout and upgrades on the next ensure', async () => {
    await ensure();
    await pg.unsafe('CREATE SCHEMA timeout_recovery');
    await pg.unsafe('SET search_path TO timeout_recovery, public');
    let timedOut = false;
    const interrupted = new Proxy(pg, {
      get(target, key) {
        if (key === 'begin')
          return (run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
            target.begin((tx) =>
              run(
                new Proxy(tx, {
                  get(transaction, property) {
                    if (property === 'unsafe')
                      return async (query: string, params: never) => {
                        if (!timedOut && query.startsWith('CREATE TEXT SEARCH CONFIGURATION')) {
                          timedOut = true;
                          await transaction.unsafe('SET LOCAL statement_timeout = 10');
                          await transaction.unsafe('SELECT pg_sleep(0.1)');
                        }
                        return transaction.unsafe(query, params);
                      };
                    return Reflect.get(transaction, property);
                  },
                }),
              ),
            );
        return Reflect.get(target, key);
      },
    });
    try {
      await expect(
        ensureGlobalKbSchema({ pg: interrupted, embeddingDimensions: DIMS }),
      ).resolves.toBeDefined();
      expect(timedOut).toBe(true);
      const configs = await pg.unsafe(`SELECT cfgname FROM pg_ts_config c
        JOIN pg_namespace n ON n.oid = c.cfgnamespace WHERE n.nspname = current_schema()`);
      expect(configs).toEqual([]);
      await insert('timeout', 'kotolňa runs');
      const conn = {
        pg,
        mode: 'internal',
        embeddingDimensions: DIMS,
        close: async () => {},
      } as const;
      expect(
        (await ragHybridSearch(conn, [], 'kotolňa', { lexicalOnly: true })).map(
          (hit) => hit.sectionId,
        ),
      ).toEqual(['timeout']);
      expect(await ragHybridSearch(conn, [], 'kotolna', { lexicalOnly: true })).toEqual([]);
      await ensure();
      expect(
        (await ragHybridSearch(conn, [], 'kotolna', { lexicalOnly: true })).map(
          (hit) => hit.sectionId,
        ),
      ).toEqual(['timeout']);
    } finally {
      await pg.unsafe('SET search_path TO public');
      await pg.unsafe('DROP SCHEMA timeout_recovery CASCADE');
    }
  }, 30_000);

  it('skips a locked backfill row, keeps its debt owed, and resumes after unlock', async () => {
    await ensure();
    await insert('locked', 'kotolňa');
    await insert('unlocked', 'kotolňa');
    await pg.unsafe(`UPDATE ai_rag_embeddings SET content_tsv = to_tsvector('english', content)
      WHERE section_id IN ('locked', 'unlocked')`);
    const locker = postgres(withDatabase(ADMIN_URL, SCRATCH_DB), { max: 1, onnotice: () => {} });
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const held = locker.begin(async (tx) => {
      await tx.unsafe(`SELECT id FROM ai_rag_embeddings WHERE section_id = 'locked' FOR UPDATE`);
      ready();
      await released;
    });
    const backfill = () =>
      backfillGlobalIdentifierTsv((run) =>
        pg.begin(async (tx) => {
          await tx.unsafe('SET LOCAL statement_timeout = 250');
          return run(tx);
        }),
      );
    try {
      await locked;
      expect(await backfill()).toBe(false);
      expect(await matches(`'${IDENTIFIER_TSV_SENTINEL}'`)).toContain('unlocked');
      expect(await matches(`'${IDENTIFIER_TSV_SENTINEL}'`)).not.toContain('locked');
    } finally {
      release();
      await held;
      await locker.end({ timeout: 5 });
    }
    const before = await pg.unsafe(
      `SELECT xmin::text AS x FROM ai_rag_embeddings WHERE section_id = 'unlocked'`,
    );
    expect(await backfill()).toBe(true);
    expect(await matches(`'${IDENTIFIER_TSV_SENTINEL}'`)).toContain('locked');
    expect(
      await pg.unsafe(
        `SELECT xmin::text AS x FROM ai_rag_embeddings WHERE section_id = 'unlocked'`,
      ),
    ).toEqual(before);
  }, 30_000);

  it('matches a snake_case name whole, for a new row and for a row written before', async () => {
    await ensure();
    await insert('new', 'Call pdf_generator to render the invoice.');
    await insert('legacy', 'The pdf_generator module renders invoices.');
    await pg.unsafe(
      `UPDATE ai_rag_embeddings SET content_tsv = to_tsvector('english', content) WHERE section_id = 'legacy'`,
    );
    expect(await matches(`'pdf_generator'`), 'before the second ensure').toEqual(['new']);

    await ensure();

    expect(await matches(`'pdf_generator'`)).toEqual(['legacy', 'new']);
  }, 30_000);

  it('rewrites nothing on a further ensure', async () => {
    await ensure();
    const before = await xmins();
    expect(before.length).toBeGreaterThan(1);

    await ensure();

    expect(await xmins()).toEqual(before);
  }, 30_000);

  it('backfills a legacy row whose prose carries every word of the sentinel, and leaves a stamped row alone', async () => {
    const prose = `Notes on ${IDENTIFIER_TSV_SENTINEL} and haive tsv v3 and haivetsvv2 as plain words, then pdf_generator.`;
    await ensure();
    await insert('prose-new', prose);
    await insert('prose-legacy', prose);
    await pg.unsafe(
      `UPDATE ai_rag_embeddings SET content_tsv = to_tsvector('english', content) WHERE section_id = 'prose-legacy'`,
    );
    const whole = async (section: string) =>
      (
        await pg.unsafe(
          `SELECT content_tsv @@ $1::tsquery AS hit FROM ai_rag_embeddings WHERE section_id = $2`,
          [`'pdf_generator'`, section],
        )
      )[0]!.hit as boolean;

    await ensure();
    const first = await xmins();
    await ensure();

    expect(await whole('prose-legacy'), 'the legacy row').toBe(true);
    expect(await whole('prose-new')).toBe(true);
    expect(await xmins()).toEqual(first);
  }, 30_000);

  it('does not stamp a plain english vector of text holding every word of the sentinel', async () => {
    const hit = await pg.unsafe(`SELECT to_tsvector('english', $1) @@ $2::tsquery AS hit`, [
      `${IDENTIFIER_TSV_SENTINEL} haive tsv v3 haivetsvv2`,
      SENTINEL_QUERY,
    ]);
    expect(hit[0]!.hit).toBe(false);
  }, 30_000);
});
