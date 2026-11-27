import path from 'node:path';
import { and, desc, eq, gt, inArray, ne, or } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CANCEL_REDRIVE_LOOKBACK_MS } from './cancel-teardown.js';

/** A rebuild keeps the old folder, but cannot leave an unfinished task pointing into it. */
export async function checkoutWorktreeRefusal(
  db: Pick<Database, 'query'>,
  repositoryId: string,
  checkout: string,
): Promise<string | null> {
  const candidates = await db.query.tasks.findMany({
    where: and(eq(schema.tasks.repositoryId, repositoryId), ne(schema.tasks.status, 'completed')),
    columns: { id: true, worktreePath: true, status: true },
  });
  // Cancel commits before its asynchronous teardown. Match migration 0186: only a cancel
  // inside the worker's re-drive window can hold; older ones may predate finish events.
  const cancelledIds = candidates
    .filter((task) => task.status === 'cancelled')
    .map((task) => task.id);
  const events =
    cancelledIds.length === 0
      ? []
      : await db.query.taskEvents.findMany({
          where: and(
            inArray(schema.taskEvents.taskId, cancelledIds),
            or(
              eq(schema.taskEvents.eventType, 'task.cancel_finished'),
              and(
                eq(schema.taskEvents.eventType, 'task.cancelled'),
                gt(schema.taskEvents.createdAt, new Date(Date.now() - CANCEL_REDRIVE_LOOKBACK_MS)),
              ),
            ),
          ),
          columns: { taskId: true, eventType: true },
        });
  const finished = new Set(
    events
      .filter((event) => event.eventType === 'task.cancel_finished')
      .map((event) => event.taskId),
  );
  const recent = new Set(
    events.filter((event) => event.eventType === 'task.cancelled').map((event) => event.taskId),
  );
  const tasks = candidates.filter(
    (task) => task.status !== 'cancelled' || (recent.has(task.id) && !finished.has(task.id)),
  );
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
    ? `${count} ${count === 1 ? 'task has' : 'tasks have'} a worktree inside this checkout. Finish or cancel ${count === 1 ? 'it' : 'them'} and wait for cancellation cleanup before rebuilding.`
    : null;
}
