-- Drops the retired per-task "CLI touched" marker table. Nothing writes it (a CLI picked in a task
-- is a task_step_cli_choices row) and nothing reads it, so the rows left in it are dead weight.
-- Rollback: the rows are not recoverable from this file; restore them from a dump taken before it
-- runs. Do not delete or revert this file once any database has run it: a database that has applied
-- a migration its code lacks is refused as a fork as soon as any later migration is pending. To
-- bring the table back, add a new numbered migration that recreates it from the baseline
-- (0000_baseline.sql: the CREATE TABLE, its foreign key to tasks, the unique index
-- task_step_cli_touched_pk and the index task_step_cli_touched_task_id_idx), each guarded.
DROP TABLE IF EXISTS "task_step_cli_touched";
