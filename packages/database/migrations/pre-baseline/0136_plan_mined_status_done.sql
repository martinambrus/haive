-- A plan mined FROM a repository describes code that already exists, so its
-- nodes now arrive `done` rather than `todo`. This back-fills the plans built
-- before that: MEASURED on the dev install, a from_repo build had produced 644
-- nodes and every one of them claimed there was work to do.
--
-- Scoped through the SOURCE TASK, not the repository: only nodes an agent wrote
-- during a from_repo plan_build are mined descriptions of existing code. A node
-- typed by hand, imported from a document, or drafted from a brief describes
-- something that may genuinely not exist, and must keep its status.
--
-- Guarded on `status = 'todo'` so a verdict a PERSON entered — done,
-- blocked_human, not_applicable, in_progress — is never overwritten. That guard
-- is also what makes this safe to re-run: a second pass matches nothing.
--
-- Rollback: the same statement with 'done' and 'todo' swapped. Note it would
-- also flatten anything legitimately finished since, which is why the forward
-- direction is narrow rather than "green the whole plan".
UPDATE "plan_nodes" n
   SET "status" = 'done'
  FROM "tasks" t
 WHERE n."source_task_id" = t."id"
   AND t."type" = 'plan_build'
   AND t."metadata"->>'planBuildMode' = 'from_repo'
   AND n."status" = 'todo';
