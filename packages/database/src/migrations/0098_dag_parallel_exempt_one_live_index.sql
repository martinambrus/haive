-- Exempt 'dag_parallel' from the one-live-invocation-per-step index.
--
-- cli_invocations_one_live_per_step_idx (migration 0096) allowed at most one live
-- (ended_at IS NULL AND superseded_at IS NULL) invocation per task_step_id where
-- mode <> 'agent_mining'. The DAG executor's coder/reviewer fan-out shares the ONE
-- 06c task_step_id and (from migration 0097) now writes mode='dag_parallel', so the
-- predicate must exclude it too or the 2nd concurrent DAG insert fails with 23505.
-- This mirrors the app-side dispatch guard hasLiveInvocation (step-runner.ts), kept
-- byte-identical: mode NOT IN ('agent_mining','dag_parallel').
--
-- Requires 'dag_parallel' to already exist in the enum -- apply 0097 (committed)
-- BEFORE this file / `drizzle-kit push`. Loosening the predicate only EXCLUDES more
-- rows, so it can never fail to build against existing data; no pre-supersede is
-- needed on the way in (unlike 0096).
--
-- Deploy note: 0097 then this file via psql BEFORE push, or 0097 via psql then push
-- (which drops+recreates the index from the schema). Idempotent parity/rollback record.
--
-- Rollback (restore the stricter 0096 predicate). CAUTION: re-including 'dag_parallel'
-- means a step with 2+ live dag_parallel rows (a DAG level mid-flight) would fail the
-- CREATE on duplicates -- supersede live dag_parallel rows first, or roll back only
-- when no DAG task is mid-level:
--   UPDATE "cli_invocations" c SET "superseded_at" = now()
--   WHERE c."ended_at" IS NULL AND c."superseded_at" IS NULL AND c."mode" = 'dag_parallel'
--     AND EXISTS (SELECT 1 FROM "cli_invocations" c2
--       WHERE c2."task_step_id" = c."task_step_id" AND c2."ended_at" IS NULL
--         AND c2."superseded_at" IS NULL AND c2."mode" <> 'agent_mining'
--         AND (c2."created_at", c2."id") > (c."created_at", c."id"));
--   DROP INDEX IF EXISTS "cli_invocations_one_live_per_step_idx";
--   CREATE UNIQUE INDEX IF NOT EXISTS "cli_invocations_one_live_per_step_idx"
--     ON "cli_invocations" ("task_step_id")
--     WHERE "ended_at" IS NULL AND "superseded_at" IS NULL AND "mode" <> 'agent_mining';

DROP INDEX IF EXISTS "cli_invocations_one_live_per_step_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "cli_invocations_one_live_per_step_idx"
  ON "cli_invocations" ("task_step_id")
  WHERE "ended_at" IS NULL AND "superseded_at" IS NULL
    AND "mode" <> 'agent_mining' AND "mode" <> 'dag_parallel';
