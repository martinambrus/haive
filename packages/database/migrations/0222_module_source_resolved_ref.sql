-- Preserve the branch/tag namespace selected alongside the pinned commit.
-- Legacy pins remain NULL and recover their namespace from a matching advertised SHA.
-- Rollback: old code tolerates this nullable column; leave it in place when reverting code.
-- Dropping it loses namespace history and requires a later forward migration.
ALTER TABLE module_sources ADD COLUMN IF NOT EXISTS resolved_ref text;
