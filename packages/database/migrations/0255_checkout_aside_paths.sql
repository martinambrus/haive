-- Kept independently of display copy; refresh re-discovers legacy/interrupted rename siblings.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS checkout_aside_paths jsonb NOT NULL DEFAULT '[]'::jsonb;
