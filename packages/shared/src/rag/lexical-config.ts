import type postgres from 'postgres';

/** These configurations are durable store-local mode markers, not extension capability probes.
 * A reader may reach an old store before its next ensure, hence the final English fallback.
 * Never replace an installed accent configuration with the verbatim one on a later failure. */
const ACCENT_CONFIG = 'public.haive_english_unaccent_v1';
const VERBATIM_CONFIG = 'public.haive_english_verbatim_v1';
const configLookupSql = (config: string) =>
  `SELECT oid AS config FROM pg_catalog.pg_ts_config WHERE cfgnamespace = 'public'::regnamespace AND cfgname = '${config.slice('public.'.length)}'`;
export const RAG_TEXT_CONFIG_SQL = `COALESCE((SELECT oid::regconfig FROM pg_catalog.pg_ts_config
  WHERE cfgnamespace = 'public'::regnamespace AND cfgname IN ('haive_english_unaccent_v1', 'haive_english_verbatim_v1')
  ORDER BY cfgname LIMIT 1), 'pg_catalog.english'::regconfig)`;

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
  } catch (err) {
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
    return;
  }

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
}
