-- A `created` upgrade is an older release's creation that failed part-way; no sweep starts or ends
-- one, so it would hold the index below against every later upgrade and rollback.
UPDATE tasks
SET status = 'failed',
    error_message = 'This upgrade or rollback never started, because its creation did not finish; retry it to start it.',
    completed_at = now(),
    updated_at = now()
WHERE type = 'onboarding_upgrade'
  AND status = 'created';

-- The index cannot be built over two live ones, so a repository keeps its newest.
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

-- One live upgrade or rollback per repository, whoever writes the status. Reverts with DROP INDEX.
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_one_live_upgrade_per_repo_idx" ON "tasks" USING btree ("repository_id") WHERE "tasks"."type" = 'onboarding_upgrade' and "tasks"."status" in ('created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr');
