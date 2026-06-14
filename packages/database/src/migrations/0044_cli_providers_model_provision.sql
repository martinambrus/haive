-- On-save Ollama model provisioning: track the pull/build status (and error) per
-- provider so the CLI provider form can show progress without a worker restart.
-- Additive + idempotent; non-ollama / cloud / remote providers stay 'idle'.
ALTER TABLE "cli_providers" ADD COLUMN IF NOT EXISTS "model_provision_status" text NOT NULL DEFAULT 'idle';
ALTER TABLE "cli_providers" ADD COLUMN IF NOT EXISTS "model_provision_error" text;

-- Rollback:
-- ALTER TABLE "cli_providers" DROP COLUMN IF EXISTS "model_provision_error";
-- ALTER TABLE "cli_providers" DROP COLUMN IF EXISTS "model_provision_status";
