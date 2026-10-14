-- rollback: DROP TABLE IF EXISTS "custom_tool_calls"; DROP TYPE IF EXISTS "custom_tool_call_outcome";
--
-- One row per attempt a sandboxed agent makes at a custom tool of a prompt step: the call ('running'
-- while its action runs, then 'ok' or 'error') or its refusal with a reason code. An invocation that
-- is not live, or has spent its budget, writes none. It records no argument and no result, since both
-- carry repository or user data.
--
-- Additive and idempotent. Nothing reads the table until the first call writes a row. The undo drops
-- the call log and nothing else; the per-invocation call budget reads this table, so it starts again
-- from zero for every invocation still running.

DO $$ BEGIN
  CREATE TYPE "public"."custom_tool_call_outcome" AS ENUM('ok', 'refused', 'error', 'running');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "custom_tool_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "task_step_id" uuid,
  "cli_invocation_id" uuid,
  "step_id" varchar(128) NOT NULL,
  "tool" varchar(64) NOT NULL,
  "action" varchar(32) NOT NULL,
  "outcome" "custom_tool_call_outcome" NOT NULL,
  "reason" varchar(64),
  "http_status" integer,
  "response_bytes" integer,
  "duration_ms" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "custom_tool_calls" ADD CONSTRAINT "custom_tool_calls_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "custom_tool_calls" ADD CONSTRAINT "custom_tool_calls_task_step_id_task_steps_id_fk"
    FOREIGN KEY ("task_step_id") REFERENCES "public"."task_steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "custom_tool_calls" ADD CONSTRAINT "custom_tool_calls_cli_invocation_id_cli_invocations_id_fk"
    FOREIGN KEY ("cli_invocation_id") REFERENCES "public"."cli_invocations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "custom_tool_calls_cli_invocation_id_idx" ON "custom_tool_calls" USING btree ("cli_invocation_id");
CREATE INDEX IF NOT EXISTS "custom_tool_calls_task_id_created_at_idx" ON "custom_tool_calls" USING btree ("task_id","created_at");
