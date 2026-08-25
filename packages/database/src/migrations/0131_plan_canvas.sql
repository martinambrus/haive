-- Plan canvas: a durable, per-repo tree of what the project is MEANT to be.
--
-- Every other planning artifact in Haive is task-scoped and terminal (03b's
-- requirements doc, 04's spec, the task_dag_* rows). The knowledge base is durable
-- but descriptive. These tables are the intentional, project-level counterpart.
--
-- Additive and idempotent: five brand-new tables plus four new enum types, and
-- three additive labels on `workflow_type`. Nothing existing is altered.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS plan_node_tasks, plan_node_messages, plan_node_code_links,
--                        plan_node_edges, plan_nodes CASCADE;
--   DROP TYPE IF EXISTS plan_node_kind, plan_node_status, plan_edge_kind, plan_node_origin;
-- Nothing outside this migration references any of them. The three `workflow_type`
-- labels are the one part that cannot be undone (Postgres cannot remove an enum
-- label); they are left in place and are inert while no rows use them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_node_kind') THEN
    CREATE TYPE "plan_node_kind" AS ENUM ('component', 'decision', 'research', 'external');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_node_status') THEN
    CREATE TYPE "plan_node_status" AS ENUM ('todo', 'in_progress', 'blocked_human', 'done', 'not_applicable');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_edge_kind') THEN
    CREATE TYPE "plan_edge_kind" AS ENUM ('depends_on', 'affects', 'implements');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_node_origin') THEN
    CREATE TYPE "plan_node_origin" AS ENUM ('user', 'llm', 'import');
  END IF;
END
$$;

-- Three plan task types. Spawned only from the plan UI (they need a node id the
-- generic create-task form has no field for), so they stay out of the shared
-- create-task zod enum — the same arrangement kb_author already has.
DO $$
DECLARE
  label text;
BEGIN
  FOREACH label IN ARRAY ARRAY['plan_build', 'plan_chat', 'advisory'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'workflow_type' AND e.enumlabel = label
    ) THEN
      EXECUTE format('ALTER TYPE "workflow_type" ADD VALUE %L', label);
    END IF;
  END LOOP;
END
$$;

CREATE TABLE IF NOT EXISTS "plan_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  -- Self-FK, cascade: deleting a node deletes its subtree. A child with no parent
  -- is not a smaller plan, it is an orphan.
  "parent_id" uuid REFERENCES "plan_nodes"("id") ON DELETE CASCADE,
  -- '/<rootId>/<childId>/…/<selfId>/' — self-inclusive and slash-terminated, so
  -- `path LIKE node.path || '%'` selects the node plus its whole subtree, and the
  -- prefix match is structural rather than accidentally correct ('/a/b' would
  -- otherwise prefix-match '/a/bc').
  "path" text NOT NULL,
  "ordinal" integer NOT NULL DEFAULT 0,
  "title" varchar(512) NOT NULL,
  "kind" "plan_node_kind" NOT NULL DEFAULT 'component',
  "body" text,
  "status" "plan_node_status" NOT NULL DEFAULT 'todo',
  "taskable" boolean NOT NULL DEFAULT false,
  "version" integer NOT NULL DEFAULT 1,
  "created_by" "plan_node_origin" NOT NULL DEFAULT 'user',
  -- Provenance outlives its task: SET NULL, not cascade.
  "source_task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- One plan per repo, enforced on the root instead of by a separate `plans` table
-- (which would carry one column and buy a join on every read).
CREATE UNIQUE INDEX IF NOT EXISTS "plan_nodes_one_root_per_repo_idx"
  ON "plan_nodes" ("repository_id") WHERE "parent_id" IS NULL;
CREATE INDEX IF NOT EXISTS "plan_nodes_repo_parent_ordinal_idx"
  ON "plan_nodes" ("repository_id", "parent_id", "ordinal");
-- text_pattern_ops: the default (collation-aware) opclass will not serve LIKE 'prefix%'.
CREATE INDEX IF NOT EXISTS "plan_nodes_path_idx"
  ON "plan_nodes" USING btree ("path" text_pattern_ops);

CREATE TABLE IF NOT EXISTS "plan_node_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "from_node_id" uuid NOT NULL REFERENCES "plan_nodes"("id") ON DELETE CASCADE,
  "to_node_id" uuid NOT NULL REFERENCES "plan_nodes"("id") ON DELETE CASCADE,
  "kind" "plan_edge_kind" NOT NULL,
  "note" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "plan_node_edges_unique_idx"
  ON "plan_node_edges" ("from_node_id", "to_node_id", "kind");
CREATE INDEX IF NOT EXISTS "plan_node_edges_from_idx" ON "plan_node_edges" ("from_node_id");
CREATE INDEX IF NOT EXISTS "plan_node_edges_to_idx" ON "plan_node_edges" ("to_node_id");
CREATE INDEX IF NOT EXISTS "plan_node_edges_repo_idx" ON "plan_node_edges" ("repository_id");

CREATE TABLE IF NOT EXISTS "plan_node_code_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "node_id" uuid NOT NULL REFERENCES "plan_nodes"("id") ON DELETE CASCADE,
  "repo_path" text NOT NULL,
  "symbol" text,
  -- Why the agent linked it. Without it an impact list is an unfalsifiable claim.
  "evidence" text,
  "derived_at_commit" varchar(40),
  "confidence" real,
  -- Set by 11c-rag-reindex when a task changed this path. The difference between
  -- an impact view that is wrong and one that is merely old.
  "stale" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "plan_node_code_links_node_idx" ON "plan_node_code_links" ("node_id");
CREATE INDEX IF NOT EXISTS "plan_node_code_links_repo_path_idx"
  ON "plan_node_code_links" ("repository_id", "repo_path");
-- coalesce(symbol,'') rather than the bare column: `symbol` is nullable and
-- Postgres treats NULLs as DISTINCT in a unique index, so a plain
-- (node_id, repo_path, symbol) unique would let unlimited duplicate FILE-level
-- links through — the common case, not the edge one.
CREATE UNIQUE INDEX IF NOT EXISTS "plan_node_code_links_unique_idx"
  ON "plan_node_code_links" ("node_id", "repo_path", (coalesce("symbol", '')));

CREATE TABLE IF NOT EXISTS "plan_node_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "node_id" uuid NOT NULL REFERENCES "plan_nodes"("id") ON DELETE CASCADE,
  -- SET NULL: the transcript lives here precisely so it survives. A self-targeting
  -- reviseLoop resets the step row every cycle, so chat history cannot live on it.
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "role" varchar(16) NOT NULL,
  "body" text NOT NULL,
  "patch_json" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "plan_node_messages_node_created_idx"
  ON "plan_node_messages" ("node_id", "created_at");

CREATE TABLE IF NOT EXISTS "plan_node_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "node_id" uuid NOT NULL REFERENCES "plan_nodes"("id") ON DELETE CASCADE,
  -- Cascade, unlike the provenance columns: this row IS the link, so without the
  -- task it means nothing.
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "plan_node_tasks_unique_idx"
  ON "plan_node_tasks" ("node_id", "task_id");
CREATE INDEX IF NOT EXISTS "plan_node_tasks_task_idx" ON "plan_node_tasks" ("task_id");
