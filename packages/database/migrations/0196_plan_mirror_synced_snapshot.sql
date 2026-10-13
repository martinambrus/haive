-- The plan mirror as the checkout last held it when Haive read it in: the base of the three-way
-- reconcile of a pulled plan.json against the plan in the database.
--
-- NULL means no base is known (a row from before this column, or a plan that was never read from
-- the checkout); the first reconcile then only adds, as it always did, and stores the base.
--
-- Additive and idempotent. Undo:
--   ALTER TABLE "plan_mirror_state" DROP COLUMN IF EXISTS "synced_snapshot";
-- Rows keep working after the undo; the next reconcile has no base and only adds.

ALTER TABLE "plan_mirror_state" ADD COLUMN IF NOT EXISTS "synced_snapshot" jsonb;
