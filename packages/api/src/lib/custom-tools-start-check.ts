import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { configService } from '@haive/shared';
import {
  describeInvalidTools,
  describeToolProblems,
  parsePinnedCustomSteps,
  validateCustomTools,
} from '@haive/shared/modularity';
import { resolveCustomToolsEnabled } from '@haive/shared/modularity-server';
import { HttpError } from '../context.js';

/** Refuses a start whose pinned custom tools are unusable, so the task does not fail at its tool step. */
export async function assertCustomToolsUsable(
  handle: Pick<Database, 'select'>,
  task: { type: string; customSteps: unknown },
): Promise<void> {
  const steps = Object.entries(parsePinnedCustomSteps(task.customSteps))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => entry)
    .filter((entry) => entry.tools.length > 0 || (entry.invalidTools?.length ?? 0) > 0);
  if (steps.length === 0) return;
  const [row] = await handle
    .select({ requiresRepository: schema.taskTypeDefinitions.requiresRepository })
    .from(schema.taskTypeDefinitions)
    .where(eq(schema.taskTypeDefinitions.slug, task.type));
  const requiresRepository = row?.requiresRepository ?? true;
  for (const entry of steps) {
    const invalid = entry.invalidTools ?? [];
    const found =
      invalid.length > 0
        ? `${describeInvalidTools(invalid)}.`
        : describeToolProblems(validateCustomTools(entry.tools, { requiresRepository }));
    if (invalid.length === 0 && found === '') continue;
    throw new HttpError(
      409,
      `The step "${entry.title}" has custom tools that no longer pass their checks: ${found} The task pinned them when it was created; fix them in the task type and create a new task.`,
      'custom-tool-invalid',
    );
  }
  const withTools = steps.find((entry) => entry.tools.length > 0);
  if (withTools && !(await resolveCustomToolsEnabled(configService))) {
    throw new HttpError(
      409,
      `The step "${withTools.title}" uses custom tools (${describeInvalidTools(withTools.tools.map((t) => t.name))}), and custom tools are switched off on this install. Switch them on, then start the task.`,
      'custom-tools-switched-off',
    );
  }
}
