-- Prompt steps an admin authors on a custom task type, and the copy each task pins when it is
-- created. task_type_definitions.prompt_steps maps a step slug to its entry; tasks.custom_steps
-- maps a step id (custom.<type>.<slug>) to the entry the task was created with, null on a task
-- whose type has none.
--
-- Additive and idempotent. Every existing row reads as "no prompt steps". Undo:
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "custom_steps";
--   ALTER TABLE "task_type_definitions" DROP COLUMN IF EXISTS "prompt_steps";
-- After the undo a type or task that carried prompt steps loses them, and a task whose run list
-- names a custom step id is dead on its next pickup.

ALTER TABLE "task_type_definitions" ADD COLUMN IF NOT EXISTS "prompt_steps" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "custom_steps" jsonb;
