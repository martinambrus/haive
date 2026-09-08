import { describe, expect, it } from 'vitest';
import {
  assertNoDuplicatePrefix,
  listMigrationFiles,
  MigrationDiscoveryError,
  migrationId,
} from './discover.js';

describe('listMigrationFiles', () => {
  it('sorts byte-wise, which is also numeric order for zero-padded names', () => {
    expect(listMigrationFiles(['0153_b.sql', '0000_baseline.sql', '0152_a.sql'])).toEqual([
      '0000_baseline.sql',
      '0152_a.sql',
      '0153_b.sql',
    ]);
  });

  it('ignores non-SQL entries — they were never candidates', () => {
    expect(listMigrationFiles(['0000_baseline.sql', 'README.md', 'pre-baseline'])).toEqual([
      '0000_baseline.sql',
    ]);
  });

  // Skipping a misnamed .sql is how a migration silently goes missing: the run reports success
  // and the schema is short one change.
  it('refuses a misnamed .sql rather than skipping it', () => {
    expect(() => listMigrationFiles(['0000_baseline.sql', '0153 bad name.sql'])).toThrow(
      MigrationDiscoveryError,
    );
    expect(() => listMigrationFiles(['add_thing.sql'])).toThrow(MigrationDiscoveryError);
  });

  it('accepts a five-digit prefix, so the corpus can outgrow four', () => {
    expect(listMigrationFiles(['10000_later.sql'])).toEqual(['10000_later.sql']);
  });
});

describe('assertNoDuplicatePrefix', () => {
  it('passes on distinct prefixes', () => {
    expect(() => assertNoDuplicatePrefix(['0000_baseline.sql', '0153_a.sql'])).not.toThrow();
  });

  // The real shape from the corpus: two branches landed the same day and both claimed 0142, and
  // lexical order is the REVERSE of the order they were written in. Harmless there because
  // neither is ever executed; fatal for a file the runner will apply.
  it('rejects the 0142 shape', () => {
    expect(() =>
      assertNoDuplicatePrefix(['0142_review_dimensions.sql', '0142_task_summary_cli.sql']),
    ).toThrow(/share a numeric prefix/);
  });
});

describe('migrationId', () => {
  it('is the filename stem, so two files sharing a number remain two rows', () => {
    expect(migrationId('0142_review_dimensions.sql')).toBe('0142_review_dimensions');
    expect(migrationId('0142_task_summary_cli.sql')).toBe('0142_task_summary_cli');
  });
});
