import path from 'node:path';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

/** A rebuild keeps the old folder, but cannot leave an unfinished task pointing into it. */
export async function checkoutWorktreeRefusal(
  db: Pick<Database, 'query'>,
  repositoryId: string,
  checkout: string,
): Promise<string | null> {
  const tasks = await db.query.tasks.findMany({
    where: and(
      eq(schema.tasks.repositoryId, repositoryId),
      notInArray(schema.tasks.status, ['completed', 'cancelled']),
    ),
    columns: { id: true, worktreePath: true },
  });
  // Legacy tasks kept their pointer only in the latest setup output. Read those in one batch;
  // the durable column still wins, including when a Retry has cleared the setup output.
  const legacyIds = tasks.filter((task) => !task.worktreePath).map((task) => task.id);
  const legacyPaths = new Map<string, string | null>();
  if (legacyIds.length > 0) {
    const steps = await db.query.taskSteps.findMany({
      where: and(
        inArray(schema.taskSteps.taskId, legacyIds),
        eq(schema.taskSteps.stepId, '01-worktree-setup'),
      ),
      columns: { taskId: true, output: true },
      orderBy: desc(schema.taskSteps.round),
    });
    for (const step of steps) {
      if (legacyPaths.has(step.taskId)) continue;
      const output = step.output as { worktreePath?: unknown } | null;
      legacyPaths.set(
        step.taskId,
        typeof output?.worktreePath === 'string' ? output.worktreePath : null,
      );
    }
  }
  const count = tasks.filter((task) => {
    const worktreePath = task.worktreePath || legacyPaths.get(task.id);
    if (!worktreePath) return false;
    const rel = path.relative(checkout, worktreePath);
    return (
      rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    );
  }).length;
  return count > 0
    ? `${count} ${count === 1 ? 'task has' : 'tasks have'} a worktree inside this checkout. Finish or cancel ${count === 1 ? 'it' : 'them'} before rebuilding.`
    : null;
}
