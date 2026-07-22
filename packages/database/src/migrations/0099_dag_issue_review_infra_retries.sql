-- Split the DAG transient re-dispatch budget: give the REVIEWER its own counter.
--
-- task_dag_issues.infra_retries bounded BOTH the coder and the reviewer transient
-- re-dispatches (worker restart / SIGKILL / timeout). Sharing one counter meant a coder
-- that spent the budget left its reviewer unable to re-spawn after a later, unrelated
-- transient kill, so the issue was escalated as failed instead of simply re-reviewed
-- (observed on task bfad7af9 / ISSUE-002: coder burned infra_retries=2, then the reviewer
-- died to a worker restart with no budget left). infra_retries now bounds the CODER only;
-- review_infra_retries bounds the reviewer. Same cap (DAG_MAX_INFRA_RETRIES) per budget.
--
-- Additive, defaulted, and idempotent: safe on a live DB with in-flight DAG rows (existing
-- issues start the reviewer budget at 0, which is the correct fresh state). No backfill —
-- deliberately NOT copying infra_retries across, since the whole point is to stop the
-- coder's spend from counting against the reviewer.
--
-- Deploy note: the TS schema is authoritative and `drizzle-kit push --force` applies this
-- same ADD COLUMN; this file is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "task_dag_issues" DROP COLUMN IF EXISTS "review_infra_retries";
--   (the reviewer then shares infra_retries again — revert the code in lockstep)

ALTER TABLE "task_dag_issues"
  ADD COLUMN IF NOT EXISTS "review_infra_retries" integer NOT NULL DEFAULT 0;
