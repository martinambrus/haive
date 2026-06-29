-- Per-task direct database access toggle (default OFF). When true the per-task DDEV
-- runtime exposes the project's database on the loopback host port the runner reserved
-- at start (a socat hop to the nested db container), so a local DB client can connect
-- to 127.0.0.1:<port>. Chosen on 06-run-config (workflow) / 98-choose-view (run_app);
-- gated behind the global CONFIG_KEYS.DB_DIRECT_ACCESS switch. Default false so a DB is
-- never exposed without an explicit opt-in, and existing tasks/fixtures stay closed.
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "expose_db_port" boolean NOT NULL DEFAULT false;
