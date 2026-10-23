/**
 * The upgrade journal.
 *
 * Self-created with `CREATE TABLE IF NOT EXISTS`, not by a migration and not from the Drizzle
 * barrel — and that is forced rather than chosen. The journal has to exist BEFORE the migrate
 * phase, so it cannot be something a migration creates; and it has to work against an install
 * whose schema predates it, which is every install that ever upgrades to the first version
 * carrying it.
 *
 * The partial unique index is the durable half of "one upgrade at a time". The advisory lock
 * prevents two updaters running concurrently, but it dies with its connection; the index survives
 * a crashed updater and is what makes a second one FIND the interrupted run instead of starting a
 * competing one.
 */
export const UPGRADE_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS "upgrade_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_version" text NOT NULL,
  "to_version" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'public',
  "phase" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "ended_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "upgrade_runs_one_live_idx"
  ON "upgrade_runs" ((1)) WHERE "status" = 'running';
CREATE INDEX IF NOT EXISTS "upgrade_runs_started_at_idx" ON "upgrade_runs" ("started_at");
`;
