-- At most one live onboarding_upgrade task per repository. An upgrade and a rollback running side by
-- side apply and revert the same files, and a Retry of a failed one could revive it beside another
-- whatever the create routes checked.
--
-- A repository already holding more than one keeps its newest; the others are failed first, saying
-- why, since the index cannot be built over them. A failed task stays retryable once the live one
-- ends. Reverts with DROP INDEX.
UPDATE tasks t
SET status = 'failed',
    error_message = 'Another upgrade or rollback of this repository was in progress, so this one was stopped; retry it once that one ends.',
    completed_at = now(),
    updated_at = now()
WHERE t.type = 'onboarding_upgrade'
  AND t.status IN ('created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr')
  AND EXISTS (
    SELECT 1 FROM tasks n
    WHERE n.repository_id = t.repository_id
      AND n.type = 'onboarding_upgrade'
      AND n.status IN ('created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr')
      AND (n.created_at, n.id) > (t.created_at, t.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS "tasks_one_live_upgrade_per_repo_idx" ON "tasks" USING btree ("repository_id") WHERE "tasks"."type" = 'onboarding_upgrade' and "tasks"."status" in ('created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr');
