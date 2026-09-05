/** Code-identifier lexemes for the lexical half of RAG retrieval.
 *
 *  Postgres' text-search PARSER splits snake_case, and no configuration changes
 *  that: MEASURED, `to_tsvector('english','user_has_monter_role')` yields
 *  `user`/`monter`/`role` and `'simple'` yields the same split, because the
 *  splitting happens before any dictionary runs. So a repo's identifiers are not
 *  searchable as themselves — a query for `pdf_generator` becomes a query for the
 *  common words `pdf` and `generator`, which is why turning the lexical half on
 *  naively promoted `includes/module.inc#module_enable` (dense sim 0.2632) to
 *  rank 4.
 *
 *  These helpers extract identifiers as WHOLE tokens so they can be stored via
 *  `array_to_tsvector` (which bypasses the parser) and matched with the literal
 *  lexeme cast `'pdf_generator'::tsquery` (never `to_tsquery`, which re-runs the
 *  parser and re-splits them). ONE pattern serves the index side (the
 *  `update_content_tsv` trigger, whose SQL is built from `identifierTsvSql`) and
 *  the query side (`extractIdentifiers`), so the two cannot disagree about what
 *  an identifier is. */

/** A bare identifier or a dotted path of them. Written once and shared by the JS
 *  and Postgres evaluators; both engines read this class identically. */
export const IDENTIFIER_PATTERN = '[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)*';

/** Tokens shorter than this are noise (`id`, `db`); longer ones are minified
 *  blobs, not names. */
const MIN_IDENTIFIER_LENGTH = 3;
const MAX_IDENTIFIER_LENGTH = 64;

/** Marks a row whose `content_tsv` was built by the identifier-aware trigger, so
 *  the backfill can find the rows that still need it with an indexed predicate
 *  and converge to a no-op. Deliberately contains no `_`, `.` or camelCase
 *  boundary, so `extractIdentifiers` can NEVER emit it from a chunk's own text —
 *  otherwise indexing Haive's own source would stamp a row as upgraded when it
 *  was not, and a future version bump would skip exactly those rows. */
export const IDENTIFIER_TSV_SENTINEL = 'haivetsvv2';

/** A token is an identifier when it carries a word boundary that prose does not:
 *  an underscore, a dot, or a camelCase hump. Plain words are left to the
 *  `english` half, which already stems and ranks them. */
function isIdentifier(token: string): boolean {
  if (token.length < MIN_IDENTIFIER_LENGTH || token.length > MAX_IDENTIFIER_LENGTH) return false;
  if (token.includes('_') || token.includes('.')) return true;
  // Two humps, because one misses half the class names. `[a-z][A-Z]` catches
  // camelCase (`getTicks`, and `CNotificationEmail` via its `nE`) but NOT
  // PascalCase with a single-letter prefix — `CProduct` and `CPDF` have no
  // lowercase-then-uppercase pair anywhere, and `CProduct` is a real query term.
  // The second clause wants an uppercase-then-lowercase pair NOT at the start,
  // which admits `CProduct` while still rejecting ordinary capitalised prose
  // (`Postgres`, `Excel`) and all-caps words (`PDF`, `XLS`).
  return /[a-z][A-Z]/.test(token) || /.[A-Z][a-z]/.test(token);
}

/** The identifier lexemes of a text, lowercased and deduped.
 *
 *  A dotted token also yields its SEGMENTS. Not cosmetic: the pattern matches
 *  greedily, so `pdf_generator.class.inc` is one token and the bare
 *  `pdf_generator` would never be emitted — MEASURED, that alone made the whole
 *  feature miss its motivating case (3 chunks in 9197, dense rank 144). Segments
 *  face the same `isIdentifier` test, so `class` and `inc` are dropped while
 *  `pdf_generator` is kept. */
export function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(new RegExp(IDENTIFIER_PATTERN, 'g'))) {
    const token = match[0];
    if (isIdentifier(token)) out.add(token.toLowerCase());
    if (!token.includes('.')) continue;
    for (const segment of token.split('.')) {
      if (isIdentifier(segment)) out.add(segment.toLowerCase());
    }
  }
  return [...out];
}

/** A tsquery matching any of `terms` as literal lexemes. Returns null when there
 *  is nothing to match, which is how every caller skips the identifier ranker
 *  entirely rather than issuing a query that cannot match. */
export function identifierTsQuery(terms: string[]): string | null {
  if (terms.length === 0) return null;
  return terms.map((t) => `'${t.replace(/'/g, "''")}'`).join(' | ');
}

/** The SQL expression that derives a row's identifier lexemes from `source`,
 *  mirroring `extractIdentifiers`. Built from `IDENTIFIER_PATTERN` so the two
 *  evaluators share the pattern; the surrounding filter repeats `isIdentifier`.
 *  `array_to_tsvector` sorts and dedupes on its own, and returns an empty
 *  tsvector for an empty array, so neither needs handling here. */
export function identifierTsvSql(source: string): string {
  // The pattern is embedded VERBATIM. `standard_conforming_strings` is on, so a
  // string literal keeps its backslashes and the regex engine receives `\.` —
  // doubling them would make the engine read `\\.` as "a literal backslash, then
  // any character", which silently stops dotted tokens matching (MEASURED:
  // `d_product.inc` came back as `d_product` + `inc`, so the whole-path lexeme
  // the query side looks for was never indexed).
  const pattern = IDENTIFIER_PATTERN;
  return `array_to_tsvector(ARRAY(
      SELECT DISTINCT lower(tok) FROM (
        SELECT m[1] AS tok FROM regexp_matches(${source}, '${pattern}', 'g') m
        UNION ALL
        SELECT s FROM regexp_matches(${source}, '${pattern}', 'g') m2,
             LATERAL unnest(string_to_array(m2[1], '.')) s
      ) t
      WHERE (tok LIKE '%\\_%' OR tok LIKE '%.%'
             OR tok ~ '[a-z][A-Z]' OR tok ~ '.[A-Z][a-z]')
        AND length(tok) BETWEEN ${MIN_IDENTIFIER_LENGTH} AND ${MAX_IDENTIFIER_LENGTH}
    ))`;
}
