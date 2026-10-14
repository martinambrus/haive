-- When a deactivated module's own teardown last ran to completion; NULL until then, and again once the module is activated.
-- Additive and idempotent; undo: ALTER TABLE "modules" DROP COLUMN IF EXISTS "torn_down_at"; (what a hook removed does not come back).

ALTER TABLE "modules" ADD COLUMN IF NOT EXISTS "torn_down_at" timestamp;
