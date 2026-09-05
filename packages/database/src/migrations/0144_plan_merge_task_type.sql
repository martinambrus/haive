-- A task type for resolving a conflicted pull of the plan snapshot.
--
-- Until now both plan-snapshot directions stopped at a diverged branch: save()
-- never fetched, and pull() was `git merge --ff-only` and refused anything else.
-- The practical effect was that a plan could not reach a GitHub repository that
-- was created with a README, because a blank Haive repo and a forge-initialised
-- one share no commit at all — so every file present on both sides collides.
--
-- Resolving that needs an agent, and an agent needs a TASK: cli_invocations.task_id
-- is NOT NULL with an FK to tasks, CliExecJobPayload.taskId is required, and
-- resumeStepIfLinked returns early without a step row, so nothing would ever wake
-- the loop back up. Hence a real task type rather than something the plan-mirror
-- BullMQ job could drive on its own.
--
-- Like the other plan types it is deliberately absent from `workflowTypeSchema` in
-- @haive/shared: it is spawned from the plan page with context (the conflicting
-- paths, the merge worktree) that the generic create-task form cannot supply.
--
-- Additive and idempotent. Rollback: leave it. An unused enum value is inert —
-- Postgres has no safe DROP VALUE, and removing one would break any row already
-- carrying it. Reverting the feature means deleting the step module and the
-- routes; this value can stay behind harmlessly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'workflow_type' AND e.enumlabel = 'plan_merge'
  ) THEN
    ALTER TYPE "workflow_type" ADD VALUE 'plan_merge';
  END IF;
END
$$;
