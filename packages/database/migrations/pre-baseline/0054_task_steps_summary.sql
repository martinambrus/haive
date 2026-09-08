-- Per-step human-readable recap of what the step's LLM agent did, surfaced as the
-- collapsible "What the agent did" panel on the done card. Filled from the apply
-- output's curated summary (findingsSummary/summary/notes) when present, else by a
-- best-effort async LLM summarizer. Null on deterministic-only steps. Idempotent +
-- additive.
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "summary" text;

-- Rollback:
-- ALTER TABLE "task_steps" DROP COLUMN IF EXISTS "summary";
