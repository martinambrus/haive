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

/** Every table the baseline creates. */
export function baselineTableNames(sql: string): string[] {
  const names: string[] = [];
  for (const line of sql.split('\n')) {
    const match = CREATE_TABLE.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/** Every `table.column` the baseline creates, as a set of `"table.column"` keys. */
export function baselineColumns(sql: string): Set<string> {
  const columns = new Set<string>();
  let current: string | null = null;
  for (const line of sql.split('\n')) {
    const table = CREATE_TABLE.exec(line);
    if (table?.[1]) {
      current = table[1];
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
