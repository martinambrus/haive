-- rollback: leave it. Postgres cannot drop an enum value, an unused one is inert, and reverting the code is the undo.
-- Additive and idempotent; the value is not used in this file.
ALTER TYPE "workflow_type" ADD VALUE IF NOT EXISTS 'type_draft';
