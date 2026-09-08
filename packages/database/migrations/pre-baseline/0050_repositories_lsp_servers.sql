-- Per-repo override of the active LSP server set (env keys). NULL = no override
-- (01-declare-deps uses the form/onboarding-derived set). Set by the tooling
-- management page to enable/disable LSP servers after onboarding; injected into
-- declaredDeps so it survives the per-task declare-deps rebuild. Idempotent +
-- additive.
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "lsp_servers" text[];

-- Rollback:
-- ALTER TABLE "repositories" DROP COLUMN IF EXISTS "lsp_servers";
