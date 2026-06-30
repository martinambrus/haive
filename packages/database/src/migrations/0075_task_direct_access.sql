-- Per-task direct browser access toggle (default OFF). When true the per-task runtime
-- publishes its app to a loopback host port (DDEV also reconfigures its router to those
-- custom ports) so the user opens the app in their OWN browser via the surfaced URLs.
-- Chosen on 01b-browser-access (workflow) / 98-choose-view (run_app), BEFORE the runner
-- boots; gated behind the global CONFIG_KEYS.BROWSER_DIRECT_ACCESS kill-switch. Default
-- false so DDEV stays on portless 80/443 (VNC-only) unless a task opts in, and existing
-- tasks/fixtures stay portless. Idempotent: safe to re-run on every environment via
-- `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "direct_access" boolean NOT NULL DEFAULT false;
