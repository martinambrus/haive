ALTER TABLE rag_query_log ADD COLUMN IF NOT EXISTS result_hits jsonb;
ALTER TABLE rag_query_log ADD COLUMN IF NOT EXISTS usage_assessment jsonb;
