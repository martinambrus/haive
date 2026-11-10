import type postgres from 'postgres';

/** These configurations are durable store-local mode markers, not extension capability probes.
 * A reader may reach an old store before its next ensure, hence the final English fallback.
 * Never replace an installed accent configuration with the verbatim one on a later failure. */
const ACCENT_CONFIG = 'haive_english_unaccent_v1';
const VERBATIM_CONFIG = 'haive_english_verbatim_v1';
const configLookupSql = (config: string) =>
  `SELECT oid AS config FROM pg_catalog.pg_ts_config WHERE cfgnamespace = current_schema()::regnamespace AND cfgname = '${config}'`;
export const RAG_TEXT_CONFIG_SQL = `COALESCE((SELECT oid::regconfig FROM pg_catalog.pg_ts_config
  WHERE cfgnamespace = current_schema()::regnamespace AND cfgname IN ('haive_english_unaccent_v1', 'haive_english_verbatim_v1')
  ORDER BY (cfgname = 'haive_english_unaccent_v1') DESC LIMIT 1), 'pg_catalog.english'::regconfig)`;

// Spaces keep this sentinel impossible for either prose parser or the identifier extractor to emit.
// Verbatim vectors must NOT receive it: a later successful extension install still owes a backfill.
export const ACCENT_TSV_SENTINEL = 'haive accent tsv v1';
const accentConfigExistsSql = `EXISTS (${configLookupSql(ACCENT_CONFIG)})`;
export const RAG_ACCENT_STAMP_SQL = `CASE WHEN ${accentConfigExistsSql}
  THEN array_to_tsvector(ARRAY['${ACCENT_TSV_SENTINEL}']) ELSE ''::tsvector END`;
/** $1 is the existing identifier stamp. Both backfill entry points, including the global retry
 * sweep, read the durable store mode here; no process/pool cache can select a different mode. */
export const RAG_TSV_BACKFILL_PREDICATE = `content_tsv IS NULL OR NOT (content_tsv @@ $1::tsquery)
  OR (${accentConfigExistsSql} AND NOT (content_tsv @@ '''${ACCENT_TSV_SENTINEL}'''::tsquery))`;

export type RagSchemaStep = (
  run: (tx: postgres.TransactionSql) => Promise<postgres.RowList<postgres.Row[]>>,
) => Promise<postgres.RowList<postgres.Row[]>>;

/** Runs on the actual repository/external/global store, behind that store's schema lock.
 * The extension attempt has its own transaction: a refusal must not poison subsequent DDL.
 * The fallback config records that the warning was emitted, including across pool/process restarts.
 * A later ensure retries installation, so restored privileges/contrib can upgrade the store. */
export async function ensureRagLexicalConfig(
  step: RagSchemaStep,
  log: { warn: (fields: { err: unknown }, message: string) => void },
): Promise<void> {
  const existing = await step((tx) => tx.unsafe(configLookupSql(ACCENT_CONFIG)));
  if (existing[0]?.config) return;

  try {
    await step((tx) => tx.unsafe('CREATE EXTENSION IF NOT EXISTS unaccent'));
    await step(async (tx) => {
      const prior = await tx.unsafe(configLookupSql(ACCENT_CONFIG));
      if (prior[0]?.config) return prior;
      // An external store may already have installed the extension outside public.
      const dictionaries = await tx.unsafe(`SELECT format('%I.unaccent', n.nspname) AS dictionary
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'unaccent'`);
      const dictionary = dictionaries[0]?.dictionary;
      if (typeof dictionary !== 'string') throw new Error('unaccent dictionary not found');
      await tx.unsafe(
        `CREATE TEXT SEARCH CONFIGURATION ${ACCENT_CONFIG} (COPY = pg_catalog.english)`,
      );
      return tx.unsafe(`ALTER TEXT SEARCH CONFIGURATION ${ACCENT_CONFIG}
        ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
        WITH ${dictionary}, pg_catalog.english_stem`);
    });
  } catch (err) {
    // This includes an installed dictionary in a schema this role cannot use. The failed
    // configuration transaction rolled back, so its existence cannot falsely select accent mode.
    let newlyRecorded = false;
    await step(async (tx) => {
      const prior = await tx.unsafe(configLookupSql(VERBATIM_CONFIG));
      if (prior[0]?.config) return prior;
      const result = await tx.unsafe(
        `CREATE TEXT SEARCH CONFIGURATION ${VERBATIM_CONFIG} (COPY = pg_catalog.english)`,
      );
      newlyRecorded = true;
      return result;
    });
    if (newlyRecorded) {
      log.warn(
        { err },
        'unaccent extension unavailable; lexical retrieval keeps verbatim English matching',
      );
    }
  }
}
