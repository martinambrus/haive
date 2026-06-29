-- Per-task on-demand step-debugging toggle (default OFF). When true the per-task
-- runtime is brought up with step-debugging wired (PHP/Xdebug under DDEV, JS via
-- the VNC browser CDP, Node --inspect) so the Editor tab can attach. Chosen on the
-- 01-debug-mode step, asked once before any runtime starts; re-read at every runner
-- start so it survives warm-recover. Gated behind CONFIG_KEYS.DEBUG_MODE_ENABLED.
-- Default false so existing tasks and fixtures run with no debug overhead.
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "debug_mode" boolean NOT NULL DEFAULT false;
