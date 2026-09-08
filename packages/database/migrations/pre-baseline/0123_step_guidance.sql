-- Learned per-step prompt guidance (plan lexical-jingling-dawn.md).
--
-- Lessons about how HAIVE ASKED for the work, captured from validator/reviewer agents
-- mid-run and approved by a human at 11e-prompt-guidance. Guidance is only ever
-- APPENDED to a step's built prompt, never substituted for it, so flipping the feature
-- switch off returns every prompt to byte-identical -- that is the rollback.
--
-- Two PARTIAL unique indexes rather than one coalesce() expression index over a
-- sentinel uuid: repository_id is genuinely NULL for a global item, and a partial index
-- says so without inventing a magic value a future join could accidentally match.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file is the
-- idempotent parity/rollback record. Fully additive -- nothing existing is touched.
CREATE TABLE IF NOT EXISTS "step_guidance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "step_id" text NOT NULL,
  "scope" text NOT NULL,
  "repository_id" uuid REFERENCES "repositories"("id") ON DELETE CASCADE,
  "facets" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "provider_family" text,
  "cause" text NOT NULL,
  "guidance" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "fingerprint" text NOT NULL,
  "occurrences" integer DEFAULT 1 NOT NULL,
  "source_task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "source_step_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "step_guidance_repo_fp_idx"
  ON "step_guidance" ("step_id", "repository_id", "fingerprint")
  WHERE "repository_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "step_guidance_global_fp_idx"
  ON "step_guidance" ("step_id", "fingerprint")
  WHERE "repository_id" IS NULL;

CREATE INDEX IF NOT EXISTS "step_guidance_step_status_idx"
  ON "step_guidance" ("step_id", "status");

-- Per-repo opt-OUT. Default TRUE because the global switch is the real gate (staged
-- rollout, default off); this exists to silence one noisy repo, not to enable the
-- feature repo by repo. Matches how pr_workflow_enabled pairs with its global switch.
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "step_guidance_enabled" boolean DEFAULT true NOT NULL;

-- Rollback (each line undoes alone; safe once the code is reverted, since nothing else
-- reads either object -- and safe even BEFORE the revert, because the injection path
-- is best-effort and returns the unchanged prompt on any query failure):
--   DROP TABLE IF EXISTS "step_guidance";
--   ALTER TABLE "repositories" DROP COLUMN IF EXISTS "step_guidance_enabled";
