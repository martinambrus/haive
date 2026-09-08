-- Auto-resume on allowance reset (opt-in, default OFF via CONFIG_KEYS.AUTO_RESUME_ON_ALLOWANCE):
-- when the usage poller decides a rate-limited task's allowance is back and the global toggle
-- is on, the worker resumes the failed step instead of only notifying. Two task columns back it:
-- allowance_auto_resume_count is the consecutive-auto-resume anti-thrash counter (reset to 0 on
-- any manual action or forward step progress; at the cap the poller falls back to notify-only),
-- and allowance_auto_resumed_at is the null->set stamp the web notifier diffs into a distinct
-- "auto-resumed" browser notification (mirrors allowance_replenished_at from 0086). The count
-- column defaults to 0 so existing rows backfill cleanly; the stamp is nullable (no auto-resume
-- yet). Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "allowance_auto_resume_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "allowance_auto_resumed_at" timestamp;
