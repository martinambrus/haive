/**
 * Parse `0000_baseline.sql` for the relations and columns it creates.
 *
 * This is what the adoption classifier compares a live database against, and it MUST come from
 * the baseline rather than from the Drizzle barrel. The barrel grows: the moment a later
 * migration adds a table, a legacy database that is perfectly adoptable would no longer contain
 * every table the barrel declares, and would be refused as half-built. The baseline is frozen,
 * and its relation set is exactly "the schema as of cutover" — which is exactly what a database
 * built by the old `push --force` applier has.
 *
 * Parsing generated SQL is a very different proposition from parsing the hand-written corpus:
 * `drizzle-kit export` emits one uniform shape, verified against the real file — `CREATE TABLE
 * "name" (` on its own line, one tab-indented `"column" type …` per column, `CONSTRAINT "…"`
 * lines unquoted at the start, and a closing `);`.
 */

const CREATE_TABLE = /^CREATE TABLE "([a-z0-9_]+)" \($/;
/** A column line. Constraint lines are excluded structurally rather than by keyword: they begin
 *  with an unquoted `CONSTRAINT`, so requiring a quoted identifier first is enough. */
const COLUMN_LINE = /^\s+"([a-z0-9_]+)"\s/;

/**
 * Baseline tables a later migration drops. The adoption classifier needs every expected table
 * present before it calls a journal-less database `legacy`, so a database built by `push --force`
 * from a barrel that no longer declares one of these, or one whose journal `push` dropped, would
 * read as half-built and be refused. Leaving them out keeps both adoptable; a database that still
 * has the table is fine too, since extra tables are allowed and the dropping migration removes it.
 * `baseline.test.ts` pins this list to the corpus: add a table here in the same change as the
 * migration that drops it.
 */
export const DROPPED_SINCE_BASELINE: readonly string[] = ['task_step_cli_touched'];

/** Every table the baseline creates, except those named in `skip`. */
export function baselineTableNames(sql: string, skip: readonly string[] = []): string[] {
  const names: string[] = [];
  for (const line of sql.split('\n')) {
    const match = CREATE_TABLE.exec(line);
    if (match?.[1] && !skip.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** Every `table.column` the baseline creates, as a set of `"table.column"` keys, except the
 *  columns of tables in `skip`. */
export function baselineColumns(sql: string, skip: readonly string[] = []): Set<string> {
  const columns = new Set<string>();
  let current: string | null = null;
  for (const line of sql.split('\n')) {
    const table = CREATE_TABLE.exec(line);
    if (table?.[1]) {
      current = skip.includes(table[1]) ? null : table[1];
      continue;
    }
    if (current === null) continue;
    if (line.startsWith(');')) {
      current = null;
      continue;
    }
    const column = COLUMN_LINE.exec(line);
    if (column?.[1]) columns.add(`${current}.${column[1]}`);
  }
  return columns;
}
