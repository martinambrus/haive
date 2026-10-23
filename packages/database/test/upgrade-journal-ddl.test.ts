import { describe, expect, it } from 'vitest';
import * as database from '../src/index.js';

const ddl = (database as Record<string, unknown>).UPGRADE_JOURNAL_DDL;

describe('UPGRADE_JOURNAL_DDL', () => {
  it('is exported as one string from the package barrel', () => {
    expect(typeof ddl).toBe('string');
  });

  it('creates the upgrade_runs table with every journal column', () => {
    const text = String(ddl);
    expect(text).toContain(`CREATE TABLE IF NOT EXISTS ${'"upgrade_runs"'}`);
    for (const column of [
      '"id" uuid',
      '"from_version" text',
      '"to_version" text',
      '"channel" text',
      '"phase" text',
      '"status" text',
      '"error" text',
      '"metadata" jsonb',
      '"started_at" timestamp',
      '"updated_at" timestamp',
      '"ended_at" timestamp',
    ]) {
      expect(text).toContain(column);
    }
  });

  it('has the one-live-run partial unique index and the started_at index', () => {
    const text = String(ddl);
    expect(text).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "upgrade_runs_one_live_idx"\s+ON "upgrade_runs" \(\(1\)\) WHERE "status" = 'running'/,
    );
    expect(text).toContain(
      'CREATE INDEX IF NOT EXISTS "upgrade_runs_started_at_idx" ON "upgrade_runs" ("started_at")',
    );
  });

  it('guards every statement with IF NOT EXISTS', () => {
    const statements = String(ddl)
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(3);
    for (const statement of statements) expect(statement).toMatch(/IF NOT EXISTS/);
  });
});
