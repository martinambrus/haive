-- Rollback: revert the application code. The new nullable columns are harmless to old code;
-- the enum value cannot be dropped and is inert when unused.
-- Commit this value before the next migration uses it (one transaction per file).
ALTER TYPE "run_list_strategy" ADD VALUE IF NOT EXISTS 'derived';
