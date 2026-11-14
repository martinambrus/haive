-- A provider hold shares the pending + waiting_started_at shape of other parks.
-- The worker stamps the cause on its next poll; old rows need no copy-based backfill.
ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS provider_wait_provider_id uuid;
