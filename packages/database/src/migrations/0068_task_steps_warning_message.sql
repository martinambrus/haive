-- Standalone non-fatal advisory for a step, rendered as an amber banner in the
-- task UI (during and after the run), separate from status_message (which is
-- last-writer-wins per-file progress and would bury the warning). First use:
-- RAG embeddings falling back to CPU when the GPU is unavailable. NULL = none.
-- Rollback: ALTER TABLE "task_steps" DROP COLUMN IF EXISTS "warning_message";
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "warning_message" text;
