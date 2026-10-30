-- The repository's own AGENTS.md rules block. NULL follows Haive's live default rules; any text,
-- the empty string included, is an explicit override. Seeded from nothing: no user's personal
-- provider rules are copied into shared repository state.
-- Undo: ALTER TABLE repositories DROP COLUMN IF EXISTS agent_rules_override;
-- (a release without the column renders the block from the user's providers again, and ignores the
-- committed settings/agent-rules.md like any file it does not know.)
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS agent_rules_override text;
