-- Last actual checkout observation; do not backfill from the configured branch.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS checkout_branch text;
