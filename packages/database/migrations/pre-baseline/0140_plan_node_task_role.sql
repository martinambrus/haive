-- A task attached to a plan node can mean two opposite things, and until now
-- they were the same row:
--
--   implements  the task was created FROM this node. It IS the node's work, so
--               completing it means the node is done.
--   touched     the task changed code this node covers, recorded by the spec
--               writer's affected-components pass.
--
-- `completePlanNodesForTask` greens every linked node on completion. Without
-- this column, recording "this task affects these twelve components" would green
-- twelve components — turning a statement about blast radius into a claim that
-- the work is finished, which is the same bookkeeping lie the status roll-up
-- already refuses to make for a parent over unfinished children.
--
-- Additive and backfill-free. Every existing row was written by the create-task
-- endpoint, which is reached only when the request carries `planNodeId` — the
-- created-from-a-node path — so the `implements` default preserves exactly the
-- meaning they already had. The value is also declared in `schema/plan.ts`, so
-- `drizzle-kit push` (what the db-migrate service runs) reaches the same state
-- on an environment that never sees this file.
--
-- Rollback: remove `role` and `planNodeTaskRoleEnum` from `schema/plan.ts`, then
--   ALTER TABLE "plan_node_tasks" DROP COLUMN IF EXISTS "role";
--   DROP TYPE IF EXISTS "plan_node_task_role";
-- (that order — Postgres will not drop a type a column still uses). The only
-- thing lost is the touched/implements distinction; every row that existed
-- before this migration was `implements` anyway, so a rollback restores the
-- prior behaviour exactly. Nothing else references the column.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_node_task_role') THEN
    CREATE TYPE "plan_node_task_role" AS ENUM ('implements', 'touched');
  END IF;
END
$$;

ALTER TABLE "plan_node_tasks"
  ADD COLUMN IF NOT EXISTS "role" "plan_node_task_role" NOT NULL DEFAULT 'implements';
