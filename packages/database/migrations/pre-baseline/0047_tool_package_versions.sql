-- Per-tool available-version cache (rtk, chrome-devtools-mcp, and the pinnable
-- LSP servers), mirroring cli_package_versions. Populated by the worker
-- version-refresh job; read by the tooling upgrade-status check. Free-text PK
-- so adding a tool needs no enum migration. latest_sha256 is rtk-only (GitHub
-- release checksum) and null for registry-based tools. Idempotent + additive.
CREATE TABLE IF NOT EXISTS "tool_package_versions" (
	"name" text PRIMARY KEY NOT NULL,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_version" text,
	"latest_sha256" text,
	"fetched_at" timestamp,
	"fetch_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

-- Rollback:
-- DROP TABLE IF EXISTS "tool_package_versions";
