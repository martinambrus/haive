-- How far a user has read one plan node's chat.
--
-- Per user AND per node, not one watermark per repository: the badge has to say
-- WHICH node has a reply waiting, and a single timestamp would clear every
-- node's badge the moment any one conversation was read. A missing row means
-- nothing has been read, so every assistant turn on that node counts as unread.
--
-- Additive and idempotent. Rollback: DROP TABLE user_plan_node_reads — nothing
-- references it and the data is a read marker, not content.
CREATE TABLE IF NOT EXISTS "user_plan_node_reads" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "node_id" uuid NOT NULL REFERENCES "plan_nodes"("id") ON DELETE CASCADE,
  "last_read_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "node_id")
);
