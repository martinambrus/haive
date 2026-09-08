/**
 * Decide what kind of database the runner is pointed at, before it changes anything.
 *
 * This is the highest-risk logic in the runner, so all of it is pure and none of it touches a
 * connection: the caller gathers the evidence, this decides.
 */

export type DatabaseClass =
  /** Nothing of ours is present. Apply the baseline, then everything after it. */
  | 'fresh'
  /** Our schema is present with no journal — a database the old `push --force` applier built.
   *  Stamp the baseline as applied WITHOUT executing it, then apply everything after it. */
  | 'legacy'
  /** Already under the runner. Apply whatever is pending. */
  | 'managed'
  /** Some of our schema, but not all, and no journal. Refuse. */
  | 'indeterminate'
  /** A `schema_migrations` relation that is not ours. Refuse. */
  | 'foreign-journal';

export interface ClassifyInput {
  /** Tables the baseline creates. */
  expectedTables: readonly string[];
  /** Tables actually present in the target's `public` schema. */
  presentTables: readonly string[];
  /** Columns of an existing `schema_migrations`, or null when the relation does not exist. */
  journalColumns: readonly string[] | null;
  /** Rows in `schema_migrations`. Meaningless when `journalColumns` is null. */
  journalRowCount: number;
}

export interface Classification {
  kind: DatabaseClass;
  /** Expected tables the target does not have. Populated for `indeterminate`. */
  missingTables: string[];
  /** Journal columns we require but did not find. Populated for `foreign-journal`. */
  missingJournalColumns: string[];
}

/** The minimum shape that proves a `schema_migrations` is OURS. `schema_migrations` is one of
 *  the most common table names in the industry (Rails ships one), so finding the relation is not
 *  evidence — finding our columns in it is. */
const REQUIRED_JOURNAL_COLUMNS = ['id', 'checksum', 'applied_at'] as const;

/**
 * Classify from evidence, never from a probe table.
 *
 * A single-table probe (`SELECT 1 FROM users`) is exactly the fakeable evidence: `push --force`
 * issues its statements one at a time on one connection and NOT in a transaction, so an
 * interrupted push (Ctrl-C, OOM, a cancelled CI job) leaves an arbitrary PREFIX of the schema —
 * and `users` is near the front of it. A probe design adopts that database, never creates the
 * other ~56 tables, and the install fails on a missing relation months later.
 *
 * So the evidence is a quorum over the whole expected relation set, and only the extremes are
 * safe verdicts: all of it, or none of it. Anything strictly between is `indeterminate` and the
 * caller refuses. Half a schema cannot be mistaken for either end — that is the entire point.
 *
 * Tables only, deliberately not enums: `drizzle-kit` emits every `CREATE TYPE` before the first
 * `CREATE TABLE`, so "enums present, tables absent" is a half-state the table quorum already
 * catches, and including them would only add a way to produce a false `indeterminate`.
 */
export function classifyDatabase(input: ClassifyInput): Classification {
  const present = new Set(input.presentTables);
  const missingTables = input.expectedTables.filter((t) => !present.has(t));
  const hasAll = missingTables.length === 0;
  const hasNone = missingTables.length === input.expectedTables.length;

  if (input.journalColumns !== null) {
    const journal = new Set(input.journalColumns);
    const missingJournalColumns = REQUIRED_JOURNAL_COLUMNS.filter((c) => !journal.has(c));
    if (missingJournalColumns.length > 0) {
      return { kind: 'foreign-journal', missingTables: [], missingJournalColumns };
    }
    // A journal with rows is proof the runner has been here. The quorum is NOT consulted in that
    // case, and must not be: a later migration that legitimately DROPs one of the baseline's
    // tables would otherwise make a perfectly managed database read as half-built.
    if (input.journalRowCount > 0) {
      return { kind: 'managed', missingTables: [], missingJournalColumns: [] };
    }
    // An empty journal proves nothing on its own, so fall through to the quorum. This is also
    // what makes recovery automatic after `push --force` drops the journal table: the schema is
    // whole, so the database re-adopts instead of trying to re-create tables it already has.
  }

  if (hasNone) return { kind: 'fresh', missingTables: [], missingJournalColumns: [] };
  if (hasAll) return { kind: 'legacy', missingTables: [], missingJournalColumns: [] };
  return { kind: 'indeterminate', missingTables, missingJournalColumns: [] };
}

export interface ColumnDriftResult {
  /** `table.column` pairs the baseline declares that the database does not have. */
  missing: string[];
}

/**
 * Compare a legacy database's columns against the baseline's, on the adopt path only.
 *
 * The table quorum leaves one hole: a database last synced by `push --force` from an OLDER
 * barrel has every table but is missing COLUMNS. The quorum says `legacy`, adoption stamps the
 * baseline as applied, and the application then fails at runtime on a column that was never
 * created. This closes it.
 *
 * Extra columns are ALLOWED and that is deliberate — a developer whose database is ahead of the
 * baseline is the normal case, not a fault. It is only safe because every migration after the
 * baseline keeps the guarded, idempotent style of the corpus (`ADD COLUMN IF NOT EXISTS` and
 * friends), so a database that is ahead survives them.
 */
export function columnDrift(
  baselineColumns: ReadonlySet<string>,
  presentColumns: ReadonlySet<string>,
): ColumnDriftResult {
  return { missing: [...baselineColumns].filter((c) => !presentColumns.has(c)).sort() };
}
