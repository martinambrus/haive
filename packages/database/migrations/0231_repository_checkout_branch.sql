-- Last actual checkout observation; do not backfill from the configured branch.
-- Undo after reverting the readers/writers: ALTER TABLE repositories DROP COLUMN IF EXISTS checkout_branch;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS checkout_branch text;
