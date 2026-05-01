-- Per-agent rows for sub-agent-based knowledge mining inside a single task
-- step (e.g. 03-phase-0a-discovery). When the discovery step picks N agents
-- via the selector LLM, we enqueue one cli-exec job per agent; each writes
-- its own row here. The step's apply aggregator waits until every row for
-- the step has reached a terminal status (done|failed) before producing the
-- step output.

CREATE TYPE agent_mining_status AS ENUM ('pending', 'running', 'done', 'failed');

CREATE TABLE "task_step_agent_minings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_step_id" uuid NOT NULL REFERENCES "task_steps"("id") ON DELETE CASCADE,
  "agent_id" varchar(128) NOT NULL,
  "agent_title" varchar(256),
  "cli_provider_id" uuid REFERENCES "cli_providers"("id") ON DELETE SET NULL,

  "status" agent_mining_status NOT NULL DEFAULT 'pending',
  "cli_invocation_id" uuid,
  "output" jsonb,
  "raw_output" text,
  "error_message" text,

  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "task_step_agent_minings_task_step_id_idx"
  ON "task_step_agent_minings" ("task_step_id");

-- One row per (step, agent) — re-running a step with the same agent updates
-- the same row rather than accumulating duplicates.
CREATE UNIQUE INDEX "task_step_agent_minings_step_agent_idx"
  ON "task_step_agent_minings" ("task_step_id", "agent_id");
