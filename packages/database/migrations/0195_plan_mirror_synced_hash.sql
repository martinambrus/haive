-- The hash of the bytes of `.haive-data/plan.json` that Haive last wrote or last read in.
--
-- A plan flush compares the file on disk with this hash before it writes. A file that is neither
-- this hash nor the render about to be written holds changes Haive has not read in (a pull that
-- came from outside Haive, a hand edit), and the flush holds instead of overwriting them. A row
-- with no hash predates the guard: the boot pass stamps it where the file matches the database,
-- and a flush of one that is still unstamped adopts the file as it always did.
--
-- Additive and idempotent. Undo:
--   ALTER TABLE "plan_mirror_state" DROP COLUMN IF EXISTS "synced_hash";
-- Rows keep working after the undo; the flush then writes without comparing, as before.

ALTER TABLE "plan_mirror_state" ADD COLUMN IF NOT EXISTS "synced_hash" text;
