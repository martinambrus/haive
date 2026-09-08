-- Revisioned outbox for the repository-backed plan snapshot.
--
-- Every portable plan mutation increments revision in the SAME transaction as
-- the node/edge/code-link change. The worker advances written_revision only
-- after .haive-data/plan.json and plan.md have been atomically replaced.
-- A crash therefore leaves revision > written_revision and is retryable.
--
-- ROLLBACK: DROP TABLE IF EXISTS plan_mirror_state;

CREATE TABLE IF NOT EXISTS "plan_mirror_state" (
  "repository_id" uuid PRIMARY KEY REFERENCES "repositories"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL DEFAULT 0,
  "written_revision" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "written_at" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "plan_mirror_state_revision_nonnegative" CHECK ("revision" >= 0),
  CONSTRAINT "plan_mirror_state_written_nonnegative" CHECK ("written_revision" >= 0),
  CONSTRAINT "plan_mirror_state_written_not_ahead" CHECK ("written_revision" <= "revision")
);

-- Keep reruns able to repair a table created from an earlier draft of this
-- additive migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_mirror_state_written_not_ahead'
  ) THEN
    ALTER TABLE "plan_mirror_state"
      ADD CONSTRAINT "plan_mirror_state_written_not_ahead"
      CHECK ("written_revision" <= "revision");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "plan_mirror_state_dirty_idx"
  ON "plan_mirror_state" ("repository_id")
  WHERE "written_revision" < "revision";

-- Existing plans need one v2 refresh. Do not claim their old v1 mirror is
-- current: written_revision=0 deliberately puts them in the outbox.
INSERT INTO "plan_mirror_state" ("repository_id", "revision", "written_revision")
SELECT DISTINCT "repository_id", 1, 0
FROM "plan_nodes"
ON CONFLICT ("repository_id") DO NOTHING;
