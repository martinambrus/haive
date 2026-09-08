import { migrationId } from './discover.js';

export interface AppliedRow {
  id: string;
  checksum: string;
}

export interface LocalMigration {
  /** Filename, e.g. `0153_add_thing.sql`. */
  filename: string;
  /** Journal key — the filename without `.sql`. */
  id: string;
  checksum: string;
}

export interface MigrationPlan {
  /** Files to apply, in order. */
  toApply: LocalMigration[];
  /** Rows whose recorded checksum no longer matches the file on disk. */
  mismatched: { id: string; recorded: string; actual: string }[];
  /** Journal ids with no corresponding file. */
  unknown: string[];
}

/**
 * Work out what to apply.
 *
 * Three outcomes the caller treats differently, and the distinction between the last two is the
 * one worth stating:
 *
 * - `mismatched` is always fatal. A file whose bytes changed after it was applied means two
 *   installs claiming the same migration id have different schemas.
 * - `unknown` rows with nothing pending are a database that is AHEAD of this code — exactly what
 *   a rollback to older images produces, and legitimate. The caller warns and continues.
 * - `unknown` rows AND pending files together are an incoherent fork: this code has migrations
 *   the database never saw, and the database has migrations this code has never heard of. The
 *   caller refuses.
 */
export function planPending(
  local: readonly LocalMigration[],
  applied: readonly AppliedRow[],
): MigrationPlan {
  const appliedById = new Map(applied.map((row) => [row.id, row]));
  const localIds = new Set(local.map((m) => m.id));

  const mismatched: MigrationPlan['mismatched'] = [];
  const toApply: LocalMigration[] = [];

  for (const migration of local) {
    const row = appliedById.get(migration.id);
    if (!row) {
      toApply.push(migration);
      continue;
    }
    if (row.checksum !== migration.checksum) {
      mismatched.push({ id: migration.id, recorded: row.checksum, actual: migration.checksum });
    }
  }

  return {
    // A mismatch anywhere stops everything: the caller must not apply file 200 while file 3 is
    // in dispute, so the plan surfaces an empty apply list alongside the mismatch.
    toApply: mismatched.length > 0 ? [] : toApply,
    mismatched,
    unknown: applied.map((row) => row.id).filter((id) => !localIds.has(id)),
  };
}

/** Build the local side of a plan from filenames and their contents. */
export function localMigrations(
  files: readonly { filename: string; checksum: string }[],
): LocalMigration[] {
  return files.map(({ filename, checksum }) => ({
    filename,
    id: migrationId(filename),
    checksum,
  }));
}
