-- Declared verify commands per repository; rollback: ALTER TABLE "repositories" DROP COLUMN IF EXISTS "verify_commands";
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "verify_commands" jsonb;
