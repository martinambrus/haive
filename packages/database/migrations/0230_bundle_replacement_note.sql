-- Display copy only (a Replace ZIP's warning). Undo after reverting the readers/writers:
-- ALTER TABLE custom_bundles DROP COLUMN IF EXISTS last_replacement_note;
ALTER TABLE custom_bundles ADD COLUMN IF NOT EXISTS last_replacement_note text;
