import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  describeToolProblems,
  parsePinnedCustomSteps,
  validateCustomTools,
  type CustomTool,
} from '@haive/shared/modularity';

export const CUSTOM_TOOL_INVALID_REASON = 'custom-tool-invalid';

export const invalidToolsFailure = (found: string): string =>
  `${CUSTOM_TOOL_INVALID_REASON}: this step's tools no longer pass their checks: ${found} The task pinned them when it was created; fix them in the task type and start a new task.`;

/** The failure for pinned tools that fail the checks a save runs today, or null when they all pass. */
export function pinnedToolsFailure(
  tools: readonly CustomTool[],
  requiresRepository: boolean,
): string | null {
  const problems = validateCustomTools(tools, { requiresRepository });
  return problems.length > 0 ? invalidToolsFailure(describeToolProblems(problems)) : null;
}

/** The tools a task pinned for a step, and whether its task type requires a repository (true when the type has no row). */
export async function loadPinnedTools(
  db: Database,
  taskId: string,
  stepId: string,
): Promise<{ tools: CustomTool[]; requiresRepository: boolean }> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { customSteps: true, type: true },
  });
  const tools = parsePinnedCustomSteps(task?.customSteps)[stepId]?.tools ?? [];
  if (tools.length === 0 || !task) return { tools, requiresRepository: true };
  const row = await db.query.taskTypeDefinitions.findFirst({
    where: eq(schema.taskTypeDefinitions.slug, task.type),
    columns: { requiresRepository: true },
  });
  return { tools, requiresRepository: row?.requiresRepository ?? true };
}
