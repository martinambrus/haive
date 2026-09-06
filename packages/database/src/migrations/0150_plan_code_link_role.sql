-- A file linked to a plan node can mean two different things, and until now they
-- were the same row:
--
--   implements  the file builds the thing the node describes. What every link
--               meant before this column, and what the impact view hands a coder.
--   covers      the file TESTS it.
--
-- The distinction is what lets the test-management step be told which tests cover
-- the components a change reaches. A test file rarely turns up in an impact list
-- derived from implementation paths — E2E tests reference URLs and selectors, not
-- source paths — so without it the only way to find one is a grep, and a test that
-- still passes while no longer asserting the whole behaviour is invisible.
--
-- Additive and backfill-free. Every existing row was written by a plan builder or
-- the reconcile step, both of which were told to link "the files that already
-- implement a node", so the `implements` default preserves exactly the meaning
-- they already had. The value is also declared in `schema/plan.ts`, so
-- `drizzle-kit push` (what the db-migrate service runs) reaches the same state on
-- an environment that never sees this file.
--
-- `role` is deliberately NOT added to plan_node_code_links_unique_idx: one file
-- plays one part for one node, so re-asserting a link with a different role
-- corrects the row rather than creating a second one for the same path.
--
-- Rollback: remove `role` and `planCodeLinkRoleEnum` from `schema/plan.ts` and the
-- matching field from `planCodeLinkSchema` / `planMirrorV2Schema` in
-- `packages/shared/src/schemas/plan.ts`, then
--   ALTER TABLE "plan_node_code_links" DROP COLUMN IF EXISTS "role";
--   DROP TYPE IF EXISTS "plan_code_link_role";
-- (that order — Postgres will not drop a type a column still uses). The only thing
-- lost is the implements/covers distinction on links created after this migration;
-- every row that existed before it was `implements` anyway, so a rollback restores
-- the prior behaviour exactly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_code_link_role') THEN
    CREATE TYPE "plan_code_link_role" AS ENUM ('implements', 'covers');
  END IF;
END
$$;

ALTER TABLE "plan_node_code_links"
  ADD COLUMN IF NOT EXISTS "role" "plan_code_link_role" NOT NULL DEFAULT 'implements';
