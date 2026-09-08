import type { Sql, TransactionSql } from 'postgres';
import { runSqlScript } from './client.js';
import type { AppliedRow } from './plan.js';

/**
 * The runner's journal.
 *
 * Deliberately NOT in the Drizzle barrel. If it were, `drizzle-kit push --force` would create it
 * — and push records nothing, so a developer running push against a fresh database would end up
 * with a populated schema and an EMPTY journal, a state the adoption classifier would then have
 * to disambiguate from "runner-managed, nothing applied yet". Keeping it out means the table's
 * existence is honest evidence that the runner made it.
 *
 * The cost, which must be documented rather than discovered: `push` sees a table the barrel does
 * not declare and will offer to DROP it. That is recoverable — the schema is whole, so the next
 * run re-adopts — but it is why the interactive `pnpm db:push` (no `--force`) is the only push
 * that survives this change.
 *
 * Shape mirrors `template_manifest_cache`: string primary key, `varchar(64)` hash, `timestamp`
 * defaulting to now.
 */
export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS "schema_migrations" (
  "id" text PRIMARY KEY,
  "checksum" varchar(64) NOT NULL,
  "applied_at" timestamp NOT NULL DEFAULT now(),
  "duration_ms" integer NOT NULL,
  "applied_by" text NOT NULL,
  "haive_version" text
);
CREATE INDEX IF NOT EXISTS "schema_migrations_applied_at_idx"
  ON "schema_migrations" ("applied_at");
`;

/** Who wrote a journal row. `baseline-adopt` is the one that did NOT execute its file. */
export type AppliedBy = 'baseline-fresh' | 'baseline-adopt' | 'runner';

export const JOURNAL_TABLE = 'schema_migrations';

export async function ensureJournal(sql: Sql): Promise<void> {
  await runSqlScript(sql, SCHEMA_MIGRATIONS_DDL);
}

/** Columns of an existing `schema_migrations`, or null when the relation does not exist. */
export async function journalColumns(sql: Sql): Promise<string[] | null> {
  const exists = await sql<{ reg: string | null }[]>`
    SELECT to_regclass('public.schema_migrations')::text AS reg`;
  if (!exists[0]?.reg) return null;
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'schema_migrations'`;
  return rows.map((r) => r.column_name);
}

export async function readApplied(sql: Sql): Promise<AppliedRow[]> {
  const rows = await sql<AppliedRow[]>`
    SELECT id, checksum FROM schema_migrations ORDER BY id`;
  return rows.map((r) => ({ id: r.id, checksum: r.checksum }));
}

export async function recordApplied(
  sql: Sql | TransactionSql,
  entry: { id: string; checksum: string; durationMs: number; appliedBy: AppliedBy },
): Promise<void> {
  await sql`
    INSERT INTO schema_migrations (id, checksum, duration_ms, applied_by, haive_version)
    VALUES (${entry.id}, ${entry.checksum}, ${entry.durationMs}, ${entry.appliedBy},
            ${process.env.HAIVE_VERSION ?? null})`;
}
