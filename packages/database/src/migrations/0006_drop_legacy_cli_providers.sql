-- Drop grok, qwen, kiro CLI support. No first-party xAI CLI exists, qwen
-- overlaps with gemini/codex for orchestration, kiro's skill path sits outside
-- the industry-standard set. Adapters, catalog entries, type unions and zod
-- schemas are stripped in the same commit; this migration flushes any
-- remaining rows and reshapes the enum so the DB matches the codebase.

-- Delete rows first so the enum swap cannot orphan FK targets. Dependent
-- cli_invocations and cli_provider_secrets rows cascade via ON DELETE rules.
DELETE FROM cli_providers WHERE name IN ('grok', 'qwen', 'kiro');
DELETE FROM cli_package_versions WHERE name IN ('grok', 'qwen', 'kiro');

-- PostgreSQL does not allow dropping enum values in place. Recreate the enum
-- under a temporary name, swap every referencing column over, then drop the
-- old type.
CREATE TYPE cli_provider_name_new AS ENUM ('claude-code', 'codex', 'gemini', 'amp', 'zai');

ALTER TABLE cli_providers
  ALTER COLUMN name TYPE cli_provider_name_new
  USING name::text::cli_provider_name_new;

ALTER TABLE cli_package_versions
  ALTER COLUMN name TYPE cli_provider_name_new
  USING name::text::cli_provider_name_new;

DROP TYPE cli_provider_name;
ALTER TYPE cli_provider_name_new RENAME TO cli_provider_name;
