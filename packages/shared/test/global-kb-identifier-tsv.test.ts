import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalKbSchema } from '../src/global-kb/ensure-schema.js';
import { IDENTIFIER_TSV_SENTINEL } from '../src/rag/identifiers.js';

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
