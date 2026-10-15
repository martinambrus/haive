ALTER TYPE "public"."integration_call_outcome" ADD VALUE IF NOT EXISTS 'running';

ALTER TABLE "integration_calls" ADD COLUMN IF NOT EXISTS "reason" varchar(64);
ALTER TABLE "integration_calls" ADD COLUMN IF NOT EXISTS "duration_ms" integer;

CREATE INDEX IF NOT EXISTS "integration_calls_cli_invocation_id_idx" ON "integration_calls" USING btree ("cli_invocation_id");

ALTER TABLE "cli_invocations" ADD COLUMN IF NOT EXISTS "integrations" jsonb;
