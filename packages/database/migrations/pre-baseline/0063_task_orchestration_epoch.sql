-- Per-task orchestration generation. Bumped by every retry/reset re-drive (API
-- retry/resume/retry_ai handlers + the worker revise reset). Every advance-step
-- BullMQ job carries the epoch it was enqueued under; handleAdvanceStep skips any
-- job whose epoch is older than the task's current epoch, so a retry instantly
-- invalidates all prior in-flight/queued steps (a retry "stops, then starts")
-- while still allowing a legit same-epoch stalled-recovery re-delivery. Closes the
-- same-step concurrency race that produced duplicate task_step_agent_minings rows.
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "orchestration_epoch" integer NOT NULL DEFAULT 0;
