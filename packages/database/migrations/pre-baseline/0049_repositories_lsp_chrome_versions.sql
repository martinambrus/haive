-- Per-repo LSP server + chrome-devtools-mcp version pins. Repo-level rather than
-- only in the env-template's declaredDeps, which 01-declare-deps rebuilds from
-- the form every task (so declaredDeps-only pins would be wiped). 01-declare-deps
-- injects these into declaredDeps so renderDockerfile + the MCP launcher pick
-- them up. lsp_server_versions maps lsp key -> bare version; NULL = latest/
-- unpinned. Idempotent + additive.
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "lsp_server_versions" jsonb;
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "chrome_devtools_mcp_version" text;

-- Rollback:
-- ALTER TABLE "repositories" DROP COLUMN IF EXISTS "lsp_server_versions";
-- ALTER TABLE "repositories" DROP COLUMN IF EXISTS "chrome_devtools_mcp_version";
