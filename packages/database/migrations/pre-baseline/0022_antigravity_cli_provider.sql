-- Add the 'antigravity' variant to cli_provider_name so the Antigravity CLI
-- (binary `agy`) can be created as a provider. Antigravity restores Google
-- subscription-style coding after Gemini CLI moves to BYOK-only. Additive and
-- idempotent; existing providers are unaffected. The enum backs both
-- cli_providers.name and cli_package_versions.name.

ALTER TYPE "cli_provider_name" ADD VALUE IF NOT EXISTS 'antigravity';
