-- A plan build can now ask clarifying questions before it expands the outline. Each round's
-- questions, the person's answers and the planner's verdict on them live here, because every
-- round reopens the step's form (which clears its answers) and a Retry must resume the
-- conversation rather than start it again.
--
-- Additive and idempotent. Rollback: revert `schema/plan.ts` and
--   DROP TABLE IF EXISTS "plan_clarify_rounds";
-- Plans the rounds already shaped keep every node; only the Q&A history is lost.

CREATE TABLE IF NOT EXISTS "plan_clarify_rounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "round" integer NOT NULL,
  "questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "nothing_open" boolean DEFAULT false NOT NULL,
  "answers" jsonb,
  "steer" text,
  "action" varchar(16),
  "answered_at" timestamp,
  "outcome" jsonb,
  "integrated_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "plan_clarify_rounds" ADD CONSTRAINT "plan_clarify_rounds_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "plan_clarify_rounds_task_round_idx" ON "plan_clarify_rounds" USING btree ("task_id", "round");
