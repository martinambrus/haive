-- A merge dir (the shared `<base>--base` worktree, or a checkout a merge runs in) is owned by one
-- task step from the first git write in it until its merge is done, torn down by a cancel or the
-- task is gone. The owner was derived from every task's recorded merge phase and status, which left
-- the gaps between phases (a base-sync round, a cancelled task's teardown) unowned. One row per dir
-- makes the ownership a fact the claim and every host-side write to the dir are checked against.
--
-- Backfill: each dir a live task's merge already holds (an open merge, a base-sync round, or a
-- landed one the squash or the push has yet to finish) is claimed by the oldest such step. A
-- cancelled task counts as live until its `task.cancel_finished` event exists: its fixer may still
-- be running, and the teardown that records the event releases the claim. Only a cancel the worker
-- still re-drives (one within the last 7 days) counts: an older one would hold its dir for good.
--
-- Additive and idempotent. Rollback: revert `schema/merge-dir-claims.ts` and the worker, then
--   DROP TABLE IF EXISTS "merge_dir_claims";
-- A merge in flight then runs unclaimed, as before this table existed.

CREATE TABLE IF NOT EXISTS "merge_dir_claims" (
  "merge_dir" text PRIMARY KEY NOT NULL,
  "task_id" uuid NOT NULL,
  "task_step_id" uuid NOT NULL,
  "claimed_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "merge_dir_claims" ADD CONSTRAINT "merge_dir_claims_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "merge_dir_claims" ADD CONSTRAINT "merge_dir_claims_task_step_id_task_steps_id_fk"
    FOREIGN KEY ("task_step_id") REFERENCES "public"."task_steps"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "merge_dir_claims_task_id_idx" ON "merge_dir_claims" USING btree ("task_id");

INSERT INTO "merge_dir_claims" ("merge_dir", "task_id", "task_step_id")
SELECT DISTINCT ON (ts."merge_resolve_state" ->> 'mergeDir')
  ts."merge_resolve_state" ->> 'mergeDir', ts."task_id", ts."id"
FROM "task_steps" ts
JOIN "tasks" t ON t."id" = ts."task_id"
WHERE (
    ts."merge_resolve_state" ->> 'phase' IN ('resolving', 'awaiting-guidance', 'squashing', 'pushing')
    OR (ts."merge_resolve_state" ->> 'phase' = 'pending'
        AND ts."merge_resolve_state" ->> 'mergeStage' = 'base-sync')
  )
  AND ts."merge_resolve_state" ->> 'mergeDir' IS NOT NULL
  AND (
    t."status" NOT IN ('completed', 'cancelled')
    OR (t."status" = 'cancelled'
        AND NOT EXISTS (
          SELECT 1 FROM "task_events" e
          WHERE e."task_id" = t."id" AND e."event_type" = 'task.cancel_finished'
        )
        AND EXISTS (
          SELECT 1 FROM "task_events" e
          WHERE e."task_id" = t."id" AND e."event_type" = 'task.cancelled'
            AND e."created_at" > now() - interval '7 days'
        ))
  )
ORDER BY ts."merge_resolve_state" ->> 'mergeDir', ts."updated_at"
ON CONFLICT DO NOTHING;
