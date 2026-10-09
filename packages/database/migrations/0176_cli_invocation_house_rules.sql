-- Which house rules a CLI run was given; NULL means not recorded. Undo: DROP COLUMN house_rules.
ALTER TABLE cli_invocations ADD COLUMN IF NOT EXISTS house_rules jsonb;
