/** How many lines from the top of a file may carry a directive.
 *
 *  Header-scoped on purpose, and this is not pedantry. `pre-baseline/0005_cli_provider_rules_content.sql`
 *  embeds a ~108-line markdown document inside a `$rules$`-tagged literal — prose that contains
 *  semicolons, a `--stat` sequence and a bare `---`. An unscoped match would let a future file's
 *  PROSE silently switch its own execution mode from atomic to non-atomic. A directive is a header
 *  declaration or it is nothing. */
const DIRECTIVE_HEADER_LINES = 20;

/** Marks a file that must NOT run inside a transaction — `CREATE INDEX CONCURRENTLY`, and
 *  essentially nothing else. Zero files declare it today. */
const NO_TRANSACTION = /^--\s*haive:no-transaction\s*$/;

export interface MigrationDirectives {
  /** Run this file outside `BEGIN`/`COMMIT`, journalling it immediately afterwards. */
  noTransaction: boolean;
}

/**
 * Read the directives from a migration's header.
 *
 * Pure, so the header-scoping rule can be tested against the real bytes of the one file in the
 * corpus that would defeat a naive scan.
 */
export function parseDirectives(text: string): MigrationDirectives {
  const header = text.split('\n', DIRECTIVE_HEADER_LINES);
  return { noTransaction: header.some((line) => NO_TRANSACTION.test(line)) };
}
