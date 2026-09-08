/** A migration filename: four or more digits, an underscore, a lowercase slug, `.sql`. */
const MIGRATION_NAME = /^(\d{4,})_[a-z0-9_]+\.sql$/;

export class MigrationDiscoveryError extends Error {}

/**
 * Select and order the migration files the runner may apply, from a directory listing.
 *
 * Takes names rather than reading the filesystem so the ordering and rejection rules can be
 * unit-tested without fixtures on disk.
 *
 * Ordering is BYTE-WISE on the filename, never a parsed integer. The corpus proves why the
 * distinction is worth stating: `0142` was used twice (two branches landing the same day), and
 * `0065` was never created at all. Byte order handles both without any notion of an expected
 * next number — and the journal is keyed by filename stem for the same reason, so two files
 * sharing a prefix remain two distinct rows rather than a collision.
 *
 * A `.sql` file whose name does NOT match the pattern is a hard failure, never a silent skip.
 * Skipping is how a migration goes missing: the run reports success, the schema is short one
 * change, and nothing says so. Non-`.sql` entries (the pre-baseline README, an editor's backup)
 * are ignored quietly because they were never candidates.
 */
export function listMigrationFiles(entries: readonly string[]): string[] {
  const sqlFiles = entries.filter((name) => name.endsWith('.sql'));
  const bad = sqlFiles.filter((name) => !MIGRATION_NAME.test(name));
  if (bad.length > 0) {
    throw new MigrationDiscoveryError(
      `migration files must be named NNNN_lower_snake.sql — refusing to run with these present, ` +
        `because silently skipping one loses a schema change: ${bad.sort().join(', ')}`,
    );
  }
  return [...sqlFiles].sort();
}

/**
 * Reject two live migrations sharing a numeric prefix.
 *
 * `0142_review_dimensions.sql` and `0142_task_summary_cli.sql` both exist in the pre-baseline
 * corpus, and their lexical order is the REVERSE of the order they landed in. That was harmless
 * only because neither is ever executed. For a file the runner will apply, the same accident
 * would silently fix an apply order that contradicts the order the changes were written in — so
 * it fails here instead, on the pull request that created it.
 */
export function assertNoDuplicatePrefix(names: readonly string[]): void {
  const byPrefix = new Map<string, string[]>();
  for (const name of names) {
    const prefix = MIGRATION_NAME.exec(name)?.[1];
    if (!prefix) continue;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }
  const clashes = [...byPrefix.entries()].filter(([, files]) => files.length > 1);
  if (clashes.length > 0) {
    throw new MigrationDiscoveryError(
      `two migrations share a numeric prefix, so their apply order would be decided by ` +
        `filename rather than by intent: ` +
        clashes.map(([prefix, files]) => `${prefix} (${files.sort().join(', ')})`).join('; '),
    );
  }
}

/** The journal key for a migration file: its name without `.sql`. */
export function migrationId(filename: string): string {
  return filename.replace(/\.sql$/, '');
}
