-- A person switched RTK on this install's Tooling page: rtk_enabled is then a choice, which the project
-- state record carries and the upgrade follows, whatever the render context recorded. NULL: never.
--
-- Additive and idempotent. Undo, then revert the code (record files written meanwhile stay and are
-- imported as the team's value, as an unchosen install already does):
--   ALTER TABLE "repositories" DROP COLUMN IF EXISTS "rtk_choice_made_at";
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "rtk_choice_made_at" timestamp;
