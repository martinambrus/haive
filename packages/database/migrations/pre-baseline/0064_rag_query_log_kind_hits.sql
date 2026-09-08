-- Telemetry: per-query counts for the new RAG source_types (runbook = bug
-- investigations, learning = durable lessons), so rag_query_log shows the
-- learning/runbook split alongside kb/code. Idempotent.
ALTER TABLE "rag_query_log" ADD COLUMN IF NOT EXISTS "runbook_hits" integer NOT NULL DEFAULT 0;
ALTER TABLE "rag_query_log" ADD COLUMN IF NOT EXISTS "learning_hits" integer NOT NULL DEFAULT 0;
