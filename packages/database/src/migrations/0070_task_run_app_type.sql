-- Add the 'run_app' workflow type: a deterministic-first "run this repository"
-- task that brings the per-task runtime up (DDEV / app-runner) for the user to
-- browse/test/edit, then tears it down on finish. Idempotent.
ALTER TYPE "workflow_type" ADD VALUE IF NOT EXISTS 'run_app';
