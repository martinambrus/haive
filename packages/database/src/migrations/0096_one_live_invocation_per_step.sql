-- At most one LIVE cli_invocation per step (dispatch-race guard).
--
-- resolveLlmPhase (step-runner.ts) re-parks a step instead of dispatching when a
-- live invocation already exists, but that check-then-act has a wide TOCTOU
-- window: the guard SELECT is at the top of the function and the INSERT is ~200
-- lines later, after the slow prompt/secret-mask/auth-volume build. Two racing
-- advance-step jobs for the same step (e.g. reconcileOrphanedSteps re-enqueue +
-- a stale BullMQ redelivery after a worker restart) both pass the SELECT before
-- either INSERTs, so both dispatch -- two Validator terminals on one step. This
-- partial unique index makes the second concurrent live insert fail (23505), the
-- atomic point the code check lacked. The dispatch path catches 23505 and
-- re-parks the loser.
--
-- LIVE = ended_at IS NULL AND superseded_at IS NULL AND mode <> 'agent_mining'.
-- 'agent_mining' is excluded because the review fan-out (08c) runs N concurrent
-- invocations per step by design; this mirrors resolveLlmPhase's own guard query
-- (mode <> 'agent_mining'). NULL task_step_id rows are naturally exempt (a unique
-- index treats NULL keys as distinct), which is correct for detached rows.
--
-- Statement 1 resolves any pre-existing live duplicates before the index can be
-- created: per step, keep the greatest (created_at, id) -- the exact row
-- resolveLlmPhase would consume (orderBy created_at desc limit 1) -- and supersede
-- the older live sibling(s). Superseding is safe: resumeStepIfLinked skips
-- superseded invocations on completion, and the guard query ignores them.
--
-- Deploy note: run this file (via psql) BEFORE `drizzle-kit push` -- push cannot
-- create the unique index while live duplicates exist. After this runs, push sees
-- the index present and no-ops. This file is the idempotent parity/rollback record.
--
-- Rollback:
--   DROP INDEX IF EXISTS "cli_invocations_one_live_per_step_idx";

UPDATE "cli_invocations" c
SET "superseded_at" = now(),
    "error_message" = COALESCE(
      c."error_message",
      'superseded: duplicate live invocation (concurrent dispatch race)'
    )
WHERE c."ended_at" IS NULL
  AND c."superseded_at" IS NULL
  AND c."mode" <> 'agent_mining'
  AND EXISTS (
    SELECT 1
    FROM "cli_invocations" c2
    WHERE c2."task_step_id" = c."task_step_id"
      AND c2."ended_at" IS NULL
      AND c2."superseded_at" IS NULL
      AND c2."mode" <> 'agent_mining'
      AND (c2."created_at", c2."id") > (c."created_at", c."id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "cli_invocations_one_live_per_step_idx"
  ON "cli_invocations" ("task_step_id")
  WHERE "ended_at" IS NULL AND "superseded_at" IS NULL AND "mode" <> 'agent_mining';
