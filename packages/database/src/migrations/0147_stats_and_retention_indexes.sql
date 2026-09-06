-- Indexes for the statistics endpoints and for the CLI retention sweep.
--
-- Four range predicates that every one of these paths filters on had no index at all, so
-- each was a sequential scan. MEASURED on this instance before the change: cli_invocations
-- 2,584 rows / 452 MB (449 MB of it TOAST), tasks 26 rows. The scans are cheap at that size
-- and are not cheap at the growth rate that motivated the retention feature — ~90 MB and
-- ~515 invocations a day on a single-user install.
--
-- The statistics half:
--   - `cli_invocations (started_at)` — every window the stats pages ask for ("what did I
--     spend / run between X and Y") filters and orders on it, including the busy-span
--     interval fetch, which reads one narrow row per invocation across the whole range.
--   - `tasks (user_id, completed_at)` — the shape of essentially every stats query: this
--     user's tasks that finished inside a window. `tasks_user_id_idx` alone leaves the date
--     half to a filter.
--
-- The retention half. Both were already needed by code that shipped before this migration:
--   - `cli_invocations (ended_at)` — what `expiredStreamLogFilter` /`expiredPromptFilter`
--     age off, swept hourly. Plain rather than partial on `stream_log IS NOT NULL`: one
--     index serves the prompt sweep too, and with both windows defaulting to "keep forever"
--     there is nothing swept for a partial index to exclude.
--   - `tasks (status, completed_at)` — the subquery inside those filters (terminal status
--     with an exit time before the cutoff).
--
-- Deliberately NOT indexed: `cli_invocations (created_at)`. Nothing keys a range on it —
-- started_at is the clock every stats and retention path actually uses — and an unused
-- index is write cost for nothing on the fastest-growing table here.
--
-- No CREATE INDEX CONCURRENTLY: it is used nowhere in this repo, the tables are small, and
-- a plain CREATE is what `drizzle-kit push --force` (what db-migrate runs) issues anyway.
-- This file is the idempotent parity/rollback record; the schema of record is
-- `packages/database/src/schema/tasks.ts`.
--
-- Additive and idempotent. Rollback: revert `schema/tasks.ts` and
--   DROP INDEX IF EXISTS "cli_invocations_started_at_idx";
--   DROP INDEX IF EXISTS "cli_invocations_ended_at_idx";
--   DROP INDEX IF EXISTS "tasks_user_completed_at_idx";
--   DROP INDEX IF EXISTS "tasks_status_completed_at_idx";
-- Nothing is lost: no data is touched and every query still returns the same rows, more
-- slowly.
CREATE INDEX IF NOT EXISTS "cli_invocations_started_at_idx"
  ON "cli_invocations" ("started_at");

CREATE INDEX IF NOT EXISTS "cli_invocations_ended_at_idx"
  ON "cli_invocations" ("ended_at");

CREATE INDEX IF NOT EXISTS "tasks_user_completed_at_idx"
  ON "tasks" ("user_id", "completed_at");

CREATE INDEX IF NOT EXISTS "tasks_status_completed_at_idx"
  ON "tasks" ("status", "completed_at");
