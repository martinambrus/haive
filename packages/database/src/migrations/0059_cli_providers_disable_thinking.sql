-- Per-provider toggle: route this provider's ollama-cloud invocations through the
-- thinking-disable proxy, which injects thinking:{type:"disabled"} into /v1/messages
-- so reasoning models that hide their answer in the thinking channel (e.g.
-- deepseek-v4-pro:cloud) return visible text. No-op for non-cloud models.
ALTER TABLE "cli_providers" ADD COLUMN IF NOT EXISTS "disable_thinking" boolean NOT NULL DEFAULT false;

-- Rollback:
-- ALTER TABLE "cli_providers" DROP COLUMN IF EXISTS "disable_thinking";
