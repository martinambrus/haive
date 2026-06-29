-- Surface B: context-window usage frozen on a step when it finishes, shown as an
-- audit badge on the finished step's title row. context_tokens = peak single-
-- invocation prompt-side tokens for the step; context_window_size = that model's
-- max context; context_left_percent = 100 - round(tokens/window*100). All
-- nullable: null on deterministic (no-CLI) steps and on rows finalized before
-- this feature.
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "context_left_percent" integer;
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "context_tokens" integer;
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "context_window_size" integer;
