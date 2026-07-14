-- Pull-request close-out workflow: credentials gain a forge provider + optional API
-- base override, repositories gain a per-repo enable, tasks gain the PR record, and
-- task_status gains the waiting_pr state a task parks in while its PR is in review.
--
-- All additive and nullable (or defaulted), gated OFF by default
-- (CONFIG_KEYS.PR_WORKFLOW_ENABLED='false' + repositories.pr_workflow_enabled=false),
-- so the feature ships dark and is inert until switched on. Existing rows keep NULL PR
-- columns; the new 13-pr-wait step is a no-op for them and tasks complete as before.
--
-- Additive + idempotent: safe to re-run on every environment via `drizzle-kit push`.

-- Credential: which forge to call, and an optional self-hosted API base override.
ALTER TABLE "repo_credentials" ADD COLUMN IF NOT EXISTS "provider" varchar(32);
ALTER TABLE "repo_credentials" ADD COLUMN IF NOT EXISTS "api_base_url" text;

-- Repository: per-repo enable for the create_pr close-out action.
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "pr_workflow_enabled" boolean NOT NULL DEFAULT false;

-- Task: durable PR record (step output is nulled by _step-reset), read by the
-- 13-pr-wait park and the PR-status poller.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pr_provider" varchar(32);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pr_url" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pr_number" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pr_state" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pr_merged_at" timestamp;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pr_finalize_mode" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pr_poll_error" text;
-- The credential used to open the PR; the poller decrypts its token to read PR state.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pr_credential_id" uuid;

-- The non-terminal state a task parks in while its PR is open (poller finalizes it).
ALTER TYPE "task_status" ADD VALUE IF NOT EXISTS 'waiting_pr';
