-- Telemetry for agent RAG retrieval: one row per rag_search call through
-- /rag/search. Captures hit count, the KB-vs-code split, and top scores so the
-- UI can show retrieval efficiency and whether code (not just KB) is retrieved.
-- App telemetry in the main haive DB, not the per-project vector store.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   DROP TABLE IF EXISTS "rag_query_log";
CREATE TABLE IF NOT EXISTS "rag_query_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "query" text NOT NULL,
  "top_k" integer,
  "hit_count" integer NOT NULL DEFAULT 0,
  "kb_hits" integer NOT NULL DEFAULT 0,
  "code_hits" integer NOT NULL DEFAULT 0,
  "max_rrf" double precision NOT NULL DEFAULT 0,
  "max_dense" double precision NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "rag_query_log_task_created_idx" ON "rag_query_log" ("task_id", "created_at");
