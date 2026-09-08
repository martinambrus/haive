-- Durable, queryable review findings.
--
-- Findings previously lived only inside `task_steps.output` jsonb. Fix-loop rounds
-- preserved them (each round gets its own step row), but a manual retry nulls that
-- column via `resetStepAndDownstream`, and nothing recorded what became of a finding
-- -- whether it was fixed, dismissed by the developer, or shipped. Without that, no
-- change to the reviewers can be shown to have helped.
--
-- Writes are best-effort and nothing in the pipeline reads this table to make a
-- decision, so it is inert until something queries it.
--
-- `task_step_id` is ON DELETE SET NULL rather than CASCADE on purpose: the finding
-- must outlive the step row it came from, which is the point of the table.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   DROP TABLE IF EXISTS "review_findings";
--   DROP TYPE IF EXISTS "review_finding_disposition";
--   DROP TYPE IF EXISTS "review_severity";

DO $$ BEGIN
  CREATE TYPE "review_severity" AS ENUM ('critical', 'high', 'medium', 'low');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "review_finding_disposition" AS ENUM (
    'open', 'fixed', 'recurred', 'dismissed_human', 'dismissed_refuted', 'accepted_risk'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "review_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "task_step_id" uuid REFERENCES "task_steps"("id") ON DELETE SET NULL,
  "cli_invocation_id" uuid REFERENCES "cli_invocations"("id") ON DELETE SET NULL,
  "step_id" varchar(128) NOT NULL,
  "round" integer NOT NULL DEFAULT 0,
  "reviewer_id" varchar(128) NOT NULL,
  "severity" "review_severity" NOT NULL,
  "path" text,
  "line_start" integer,
  "line_end" integer,
  "issue" text NOT NULL,
  "fix" text,
  "fingerprint" varchar(64) NOT NULL,
  "blocking" boolean NOT NULL DEFAULT false,
  "disposition" "review_finding_disposition" NOT NULL DEFAULT 'open',
  "disposition_at" timestamp,
  "disposition_source" varchar(128),
  "raw" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "review_findings_task_id_idx" ON "review_findings" ("task_id");
CREATE INDEX IF NOT EXISTS "review_findings_task_fingerprint_idx" ON "review_findings" ("task_id", "fingerprint");
CREATE INDEX IF NOT EXISTS "review_findings_task_step_id_idx" ON "review_findings" ("task_step_id");

-- One row per finding per step row. A step's apply() can run more than once for the
-- same round -- 07b loops validator/fixer passes, and a mining retry re-runs apply()
-- after re-rolling one agent -- so writers insert with ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS "review_findings_dedupe_idx"
  ON "review_findings" ("task_id", "task_step_id", "round", "fingerprint");
